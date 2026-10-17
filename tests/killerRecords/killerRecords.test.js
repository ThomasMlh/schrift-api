import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { setDb } from '../../src/config/database.js';
import {
  loadComparableScores,
  getRotationHistory,
  getAccountRecords,
  findNewRecords,
  notifyPersonalRecords,
} from '../../src/services/killerRecords.js';

// Records and history per killer, against a real in-memory MongoDB. Model reminder: a `rotations`
// document is a template (a killer + attack type) reused across cycles, and in each cycle odd-index
// rotations are differential (score = points of the rotation alone, derived from the weekly total
// using the previous rotation's base score).
jest.setTimeout(60000);

let mongod;
let client;
let db;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');
  setDb(db); // notifyDiscord logs to activity_log through getDB()
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

// Two template killers; 'kBase' and 'kDiff' form a week (kDiff is the differential after kBase).
const seedRotations = async () => {
  const { insertedIds } = await db.collection('rotations').insertMany([
    { killer: 'Arrancar', attack: 'R', alteration: 'Gel' },
    { killer: 'Espada', attack: 'B', alteration: 'Feu' },
  ]);
  return { kBase: insertedIds[0].toString(), kDiff: insertedIds[1].toString() };
};

const seedCycle = async (name, startDate, rotationIds) => {
  const { insertedId } = await db.collection('cycles').insertOne({
    name,
    year: 2026,
    rotations: rotationIds.map((rotation_id, i) => ({ rotation_id, position: i + 1, start_date: startDate })),
  });
  return insertedId.toString();
};

const score = (cycle_id, rotation_id, bbs_id, value, extra = {}) => ({
  cycle_id, rotation_id, bbs_id, bbs_name: bbs_id.toUpperCase(), user_id: 'u-' + bbs_id,
  guild_id: 'g1', score: value, raw_score: value, is_differential: false, ...extra,
});

describe('loadComparableScores', () => {
  it('excludes a differential score whose base rotation score is missing, keeps one that has it', async () => {
    const { kBase, kDiff } = await seedRotations();
    const cycle = await seedCycle('C1', '01/01/2026', [kBase, kDiff]);
    await db.collection('scores').insertMany([
      score(cycle, kBase, 'alice', 100),
      score(cycle, kDiff, 'alice', 50, { is_differential: true, raw_score: 150 }),
      // bob has no base score: his differential holds his whole weekly total -> not comparable
      score(cycle, kDiff, 'bob', 300, { is_differential: true, raw_score: 300 }),
    ]);

    const result = await loadComparableScores(db, { rotation_id: kDiff });
    expect(result.map((s) => s.bbs_id)).toEqual(['alice']);
  });
});

describe('getRotationHistory', () => {
  it('returns absolute/guild records, record to beat outside the current cycle, and per-cycle averages in order', async () => {
    const { kBase } = await seedRotations();
    const later = await seedCycle('C2', '01/03/2026', [kBase]);
    const earlier = await seedCycle('C1', '01/01/2026', [kBase]);
    await db.collection('scores').insertMany([
      score(earlier, kBase, 'alice', 100),
      score(earlier, kBase, 'carol', 900, { guild_id: 'g2' }),
      score(later, kBase, 'alice', 300),
      score(later, kBase, 'bob', 100),
    ]);

    const history = await getRotationHistory(db, kBase, { guildId: 'g1', currentCycleId: later });

    expect(history.absolute_record).toMatchObject({ score: 900, bbs_id: 'carol', cycle_name: 'C1' });
    expect(history.guild_record).toMatchObject({ score: 300, bbs_id: 'alice', cycle_name: 'C2' });
    // Score to beat for C2 in guild g1: the best of the OTHER cycles = 100 (alice, C1)
    expect(history.record_to_beat).toMatchObject({ score: 100, cycle_name: 'C1' });
    expect(history.current_cycle_best).toMatchObject({ score: 300, bbs_id: 'alice' });
    // Chronological order (C1 before C2, even though C2 was created first)
    expect(history.per_cycle.map((c) => c.cycle_name)).toEqual(['C1', 'C2']);
    expect(history.per_cycle[0]).toMatchObject({ average: 500, count: 2, guild_average: 100, guild_count: 1 });
    expect(history.per_cycle[1]).toMatchObject({ average: 200, guild_average: 200 });
  });

  it('returns null records when there is no score yet', async () => {
    const { kBase } = await seedRotations();
    const history = await getRotationHistory(db, kBase, {});
    expect(history.absolute_record).toBeNull();
    expect(history.per_cycle).toEqual([]);
  });
});

describe('getAccountRecords', () => {
  it('returns the best score of each account per killer, with killer details and attempt count', async () => {
    const { kBase } = await seedRotations();
    const c1 = await seedCycle('C1', '01/01/2026', [kBase]);
    const c2 = await seedCycle('C2', '01/03/2026', [kBase]);
    await db.collection('scores').insertMany([
      score(c1, kBase, 'alice', 100),
      score(c2, kBase, 'alice', 250),
    ]);

    const records = await getAccountRecords(db, ['alice', 'nobody']);
    expect(records.get('alice')).toEqual([
      expect.objectContaining({ killer: 'Arrancar', attack: 'R', score: 250, cycle_name: 'C2', attempts: 2 }),
    ]);
    expect(records.get('nobody')).toEqual([]);
  });
});

describe('findNewRecords', () => {
  it('ignores the very first score on a killer (nothing to beat)', async () => {
    const { kBase } = await seedRotations();
    const c1 = await seedCycle('C1', '01/01/2026', [kBase]);
    const first = score(c1, kBase, 'alice', 500);
    await db.collection('scores').insertOne({ ...first });

    expect(await findNewRecords(db, [first])).toEqual([]);
  });

  it('flags a score beating the previous best from another cycle, not one that only ties it', async () => {
    const { kBase } = await seedRotations();
    const c1 = await seedCycle('C1', '01/01/2026', [kBase]);
    const c2 = await seedCycle('C2', '01/03/2026', [kBase]);
    await db.collection('scores').insertMany([
      score(c1, kBase, 'alice', 200),
      score(c1, kBase, 'bob', 300),
    ]);
    const aliceNew = score(c2, kBase, 'alice', 250);
    const bobNew = score(c2, kBase, 'bob', 300);
    await db.collection('scores').insertMany([{ ...aliceNew }, { ...bobNew }]);

    const records = await findNewRecords(db, [aliceNew, bobNew]);
    expect(records).toEqual([
      expect.objectContaining({ bbs_id: 'alice', previous_score: 200, new_score: 250 }),
    ]);
  });

  it('does not flag a non-comparable differential score (no base score that week)', async () => {
    const { kBase, kDiff } = await seedRotations();
    const c1 = await seedCycle('C1', '01/01/2026', [kBase, kDiff]);
    const c2 = await seedCycle('C2', '01/03/2026', [kBase, kDiff]);
    await db.collection('scores').insertMany([
      score(c1, kBase, 'alice', 100),
      score(c1, kDiff, 'alice', 50, { is_differential: true, raw_score: 150 }),
    ]);
    // Cycle 2: no base score -> the differential holds the whole total, not a real record
    const inflated = score(c2, kDiff, 'alice', 400, { is_differential: true, raw_score: 400 });
    await db.collection('scores').insertOne({ ...inflated });

    expect(await findNewRecords(db, [inflated])).toEqual([]);
  });
});

describe('notifyPersonalRecords', () => {
  it('sends one grouped personal_record notification to the guild general channel', async () => {
    const { kBase } = await seedRotations();
    const { insertedId: guildId } = await db.collection('guildes').insertOne({
      name: 'Guilde A', discord_channel_id: 'chefs', discord_general_channel_id: 'general',
    });
    const g = guildId.toString();
    const c1 = await seedCycle('C1', '01/01/2026', [kBase]);
    const c2 = await seedCycle('C2', '01/03/2026', [kBase]);
    await db.collection('scores').insertMany([
      score(c1, kBase, 'alice', 100, { guild_id: g }),
      score(c1, kBase, 'bob', 100, { guild_id: g }),
    ]);
    const fresh = [score(c2, kBase, 'alice', 150, { guild_id: g }), score(c2, kBase, 'bob', 120, { guild_id: g })];
    await db.collection('scores').insertMany(fresh.map((s) => ({ ...s })));

    const count = await notifyPersonalRecords(db, fresh);

    expect(count).toBe(2);
    const logs = await db.collection('activity_log').find({ type: 'personal_record' }).toArray();
    expect(logs).toHaveLength(1);
    expect(logs[0].channel_id).toBe('general');
    expect(logs[0].data.records).toEqual([
      expect.objectContaining({ pseudo: 'ALICE', killer: 'Arrancar', previous_score: 100, new_score: 150 }),
      expect.objectContaining({ pseudo: 'BOB', previous_score: 100, new_score: 120 }),
    ]);
  });

  it('sends nothing when no record was beaten', async () => {
    const { kBase } = await seedRotations();
    const c1 = await seedCycle('C1', '01/01/2026', [kBase]);
    const first = score(c1, kBase, 'alice', 100);
    await db.collection('scores').insertOne({ ...first });

    expect(await notifyPersonalRecords(db, [first])).toBe(0);
    expect(await db.collection('activity_log').countDocuments({ type: 'personal_record' })).toBe(0);
  });
});
