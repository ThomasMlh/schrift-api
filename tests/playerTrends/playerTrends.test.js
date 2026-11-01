import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { setDb } from '../../src/config/database.js';
import { getProgression, getDeclineAlerts, getPreviousCycle } from '../../src/services/playerTrends.js';
import { getPodiumFull } from '../../src/services/podiumService/index.js';
import { getCycleRecap } from '../../src/services/cycleRecap.js';

// Cycle-to-cycle progression, declines and end-of-cycle recap, against a real in-memory MongoDB. All
// scores here are non-differential (so all comparable): filtering differentials without a base is
// covered by killerRecords.test.js.
jest.setTimeout(60000);

let mongod;
let client;
let db;
let originalFetch;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');
  setDb(db); // notifyDiscord logs to activity_log through getDB()
  originalFetch = globalThis.fetch;
  globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => '' });
  process.env.FRONTEND_URL = 'https://front.test';
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

const seedRotations = async () => {
  const { insertedIds } = await db.collection('rotations').insertMany([
    { killer: 'Arrancar', attack: 'R', alteration: 'Gel' },
    { killer: 'Espada', attack: 'B', alteration: 'Feu' },
    { killer: 'Hollow', attack: 'G', alteration: 'Vent' },
  ]);
  return Object.values(insertedIds).map((id) => id.toString());
};

const seedCycle = async (name, startDate, rotationIds, extra = {}) => {
  const { insertedId } = await db.collection('cycles').insertOne({
    name,
    year: 2026,
    created_at: new Date(),
    rotations: rotationIds.map((rotation_id, i) => ({ rotation_id, position: i + 1, start_date: startDate, end_date: startDate })),
    ...extra,
  });
  return insertedId.toString();
};

const seedGuild = async (name, members, extra = {}) => {
  const { insertedId } = await db.collection('guildes').insertOne({ name, ...extra });
  const guildId = insertedId.toString();
  await db.collection('users').insertMany(members.map((bbs) => ({
    discord_id: `d-${bbs}`,
    global_name: bbs.toUpperCase(),
    bbs_accounts: [{ bbs_id: bbs, guilde_id: guildId }],
  })));
  return guildId;
};

const score = (cycle_id, rotation_id, bbs_id, value, guild_id = 'g1') => ({
  cycle_id, rotation_id, bbs_id, bbs_name: bbs_id.toUpperCase(), user_id: `d-${bbs_id}`,
  guild_id, score: value, raw_score: value, is_differential: false,
});

describe('getProgression', () => {
  it('ranks accounts by average improvement (%) against the previous cycle', async () => {
    const [k1, k2] = await seedRotations();
    // C2 created before C1: the order comes from the dates, not the insertion
    const c2 = await seedCycle('C2', '01/03/2026', [k1, k2]);
    const c1 = await seedCycle('C1', '01/01/2026', [k1, k2]);
    await db.collection('scores').insertMany([
      score(c1, k1, 'alice', 100), score(c1, k2, 'alice', 200),
      score(c1, k1, 'bob', 300), score(c1, k2, 'bob', 300),
      score(c2, k1, 'alice', 150), score(c2, k2, 'alice', 300),
      score(c2, k1, 'bob', 200), score(c2, k2, 'bob', 300),
      // carol did not play C1: no progression can be computed
      score(c2, k1, 'carol', 999),
    ]);

    const cycle = await db.collection('cycles').findOne({ name: 'C2' });
    const { previousCycle, rows } = await getProgression(db, { cycle });

    expect(previousCycle.name).toBe('C1');
    expect(rows.map((r) => r.bbs_id)).toEqual(['alice', 'bob']);
    expect(rows[0]).toMatchObject({ previousAverageScore: 150, averageScore: 225, progression: 75, progressionPercent: 50 });
    expect(rows[1]).toMatchObject({ previousAverageScore: 300, averageScore: 250, progressionPercent: -16.7 });
  });

  it('applies the minimum number of scores to both cycles', async () => {
    const [k1, k2] = await seedRotations();
    const c1 = await seedCycle('C1', '01/01/2026', [k1, k2]);
    const c2 = await seedCycle('C2', '01/03/2026', [k1, k2]);
    await db.collection('scores').insertMany([
      score(c1, k1, 'alice', 100),
      score(c2, k1, 'alice', 150), score(c2, k2, 'alice', 300),
    ]);

    const cycle = await db.collection('cycles').findOne({ name: 'C2' });
    expect((await getProgression(db, { cycle, minScores: 2 })).rows).toEqual([]);
    expect((await getProgression(db, { cycle, minScores: 1 })).rows).toHaveLength(1);
  });

  it('returns no rows for the first cycle', async () => {
    const [k1] = await seedRotations();
    const c1 = await seedCycle('C1', '01/01/2026', [k1]);
    expect(await getPreviousCycle(db, c1)).toBeNull();
    const cycle = await db.collection('cycles').findOne({ name: 'C1' });
    expect(await getProgression(db, { cycle })).toEqual({ previousCycle: null, rows: [] });
  });
});

describe('getPodiumFull with ranking_type=progression', () => {
  it('returns ranked rows for the guild members with their identity and the previous cycle', async () => {
    const [k1] = await seedRotations();
    const c1 = await seedCycle('C1', '01/01/2026', [k1]);
    const c2 = await seedCycle('C2', '01/03/2026', [k1]);
    const guildId = await seedGuild('Les Quincy', ['alice', 'bob']);
    await db.collection('scores').insertMany([
      score(c1, k1, 'alice', 100, guildId), score(c2, k1, 'alice', 120, guildId),
      score(c1, k1, 'bob', 100, guildId), score(c2, k1, 'bob', 200, guildId),
      score(c1, k1, 'outsider', 100), score(c2, k1, 'outsider', 900),
    ]);

    const result = await getPodiumFull(db, { cycle_name: 'C2', guild_name: 'Les Quincy', ranking_type: 'progression' });

    expect(result.meta.podiumType).toBe('progression');
    expect(result.meta.previousCycle).toMatchObject({ name: 'C1', year: 2026 });
    expect(result.data.map((r) => [r.rank, r.bbs_id, r.progressionPercent])).toEqual([[1, 'bob', 100], [2, 'alice', 20]]);
    expect(result.data[0]).toMatchObject({ global_name: 'BOB', discord_id: 'd-bob', guild_name: 'Les Quincy', hasUser: true });
  });
});

describe('getDeclineAlerts', () => {
  it('flags members whose recent scores are well below their usual score on the same killers', async () => {
    const [k1, k2, k3] = await seedRotations();
    const cycles = [];
    for (const [name, date] of [['C1', '01/01/2026'], ['C2', '01/03/2026'], ['C3', '01/05/2026']]) {
      cycles.push(await seedCycle(name, date, [k1, k2, k3]));
    }
    const guildId = await seedGuild('Les Quincy', ['alice', 'bob', 'carol']);
    const usual = { [k1]: 100, [k2]: 200, [k3]: 300 };
    const scores = [];
    for (const k of [k1, k2, k3]) {
      for (const c of cycles.slice(0, 2)) {
        scores.push(score(c, k, 'alice', usual[k], guildId), score(c, k, 'bob', usual[k], guildId));
      }
      // alice collapses on C3, bob keeps his level, carol has no history
      scores.push(score(cycles[2], k, 'alice', usual[k] / 2, guildId));
      scores.push(score(cycles[2], k, 'bob', usual[k] * 0.95, guildId));
      scores.push(score(cycles[2], k, 'carol', 1, guildId));
    }
    // dave is not in the guild
    scores.push(score(cycles[0], k1, 'dave', 100), score(cycles[2], k1, 'dave', 1), score(cycles[2], k2, 'dave', 1));
    await db.collection('scores').insertMany(scores);

    const alerts = await getDeclineAlerts(db, { guildIds: [guildId] });

    expect(alerts.map((a) => a.bbs_id)).toEqual(['alice']);
    expect(alerts[0]).toMatchObject({ ratio: 0.5, drop_percent: 50, guild_name: 'Les Quincy', global_name: 'ALICE' });
    expect(alerts[0].samples).toHaveLength(3);
    expect(alerts[0].samples[0]).toMatchObject({ cycle_name: 'C3', killer: 'Hollow', score: 150, usual: 300 });
  });

  it('ignores a single bad score and scores older than the two latest cycles', async () => {
    const [k1, k2] = await seedRotations();
    const c1 = await seedCycle('C1', '01/01/2026', [k1, k2]);
    const c2 = await seedCycle('C2', '01/03/2026', [k1, k2]);
    const c3 = await seedCycle('C3', '01/05/2026', [k1, k2]);
    await seedCycle('C4', '01/07/2026', [k1, k2]);
    const guildId = await seedGuild('Les Quincy', ['alice', 'bob']);
    await db.collection('scores').insertMany([
      // alice: a single recent score with history
      score(c1, k1, 'alice', 100, guildId), score(c3, k1, 'alice', 10, guildId),
      // bob: collapse on C2, but C2 is no longer one of the two latest cycles (C3, C4)
      score(c1, k1, 'bob', 100, guildId), score(c1, k2, 'bob', 100, guildId),
      score(c2, k1, 'bob', 10, guildId), score(c2, k2, 'bob', 10, guildId),
    ]);

    expect(await getDeclineAlerts(db, { guildIds: [guildId] })).toEqual([]);
  });
});

describe('getCycleRecap', () => {
  it('summarises a cycle for a guild: the three top 3, records beaten and guild averages', async () => {
    const [k1, k2] = await seedRotations();
    const c1 = await seedCycle('C1', '01/01/2026', [k1, k2]);
    const c2 = await seedCycle('C2', '01/03/2026', [k1, k2]);
    const c3 = await seedCycle('C3', '01/05/2026', [k1, k2]);
    const guildId = await seedGuild('Les Quincy', ['alice', 'bob']);
    await db.collection('scores').insertMany([
      score(c1, k1, 'alice', 100, guildId), score(c1, k2, 'alice', 200, guildId),
      score(c1, k1, 'bob', 300, guildId), score(c1, k2, 'bob', 300, guildId),
      score(c2, k1, 'alice', 150, guildId), score(c2, k2, 'alice', 300, guildId),
      score(c2, k1, 'bob', 200, guildId), score(c2, k2, 'bob', 300, guildId),
      // A LATER cycle must not prevent the C2 records
      score(c3, k1, 'alice', 999, guildId),
    ]);

    const cycle = await db.collection('cycles').findOne({ name: 'C2' });
    const guild = await db.collection('guildes').findOne({ name: 'Les Quincy' });
    const recap = await getCycleRecap(db, cycle, guild);

    expect(recap).toMatchObject({
      guild_name: 'Les Quincy',
      cycle_name: 'C2',
      previous_cycle_name: 'C1',
      participants: 2,
      records_count: 2,
      guild_average: 238,
      previous_guild_average: 225,
    });
    expect(recap.top3.map((p) => [p.rank, p.pseudo, p.average])).toEqual([[1, 'BOB', 250], [2, 'ALICE', 225]]);
    expect(recap.top3_max.map((p) => [p.rank, p.pseudo, p.total])).toEqual([[1, 'BOB', 500], [2, 'ALICE', 450]]);
    // BOB regressed (300 -> 250): a loss never appears on the progression podium
    expect(recap.top3_progression).toEqual([{ rank: 1, pseudo: 'ALICE', previous_average: 150, average: 225, percent: 50 }]);
    // Both records have the same relative gain (+50%): their order is not checked
    expect(recap.records.map((r) => [r.killer, r.previous_score, r.new_score]).sort()).toEqual([
      ['Arrancar', 100, 150], ['Espada', 200, 300],
    ]);
  });
});
