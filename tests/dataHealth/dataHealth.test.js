import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { getDataHealth } from '../../src/services/dataHealth.js';

jest.setTimeout(60000);

let mongod;
let client;
let db;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

const byCode = (checks) => Object.fromEntries(checks.map((c) => [c.code, c]));

describe('getDataHealth', () => {
  it('reports the problems that skew rankings', async () => {
    const { insertedId: rotationId } = await db.collection('rotations').insertOne({ killer: 'K' });
    const { insertedId: guildId } = await db.collection('guildes').insertOne({ name: 'A' });
    const { insertedId: cycleId } = await db.collection('cycles').insertOne({
      name: 'C1', year: 2026, rotations: [
        { rotation_id: rotationId.toString(), position: 1, start_date: '01/09/2026', end_date: '03/09/2026' },
        { rotation_id: 'gone', position: 2, start_date: '04/09/2026', end_date: '' },
      ],
    });
    const cycle_id = cycleId.toString();
    const rotation_id = rotationId.toString();
    await db.collection('users').insertMany([
      { bbs_accounts: [{ bbs_id: '1', bbs_name: 'Ichigo', guilde_id: guildId.toString() }] },
      { bbs_accounts: [{ bbs_id: '2', bbs_name: 'ichigo' }] },
    ]);
    await db.collection('scores').insertMany([
      { bbs_id: '1', bbs_name: 'Ichigo', cycle_id, rotation_id, guild_id: guildId.toString(), score: 600 },
      { bbs_id: '1', bbs_name: 'Ichigo', cycle_id, rotation_id, guild_id: guildId.toString(), score: 600 },
      { bbs_id: null, bbs_name: 'Nobody', cycle_id, rotation_id, guild_id: guildId.toString(), score: 500 },
      { bbs_id: '9', bbs_name: 'Ghost', cycle_id, rotation_id, guild_id: 'unknown', score: 900_000_000 },
    ]);

    const checks = byCode(await getDataHealth(db, { now: new Date(2026, 9, 1).getTime() }));
    expect(checks.duplicate_scores.count).toBe(1);
    expect(checks.implausible_scores.samples[0]).toMatchObject({ bbs_name: 'Ghost', cycle: 'C1 2026', position: 1 });
    expect(checks.scores_without_account.count).toBe(1);
    expect(checks.orphan_scores.samples).toEqual([{ bbs_id: '9', bbs_name: 'Ghost', scores: 1 }]);
    expect(checks.scores_unknown_guild.count).toBe(1);
    expect(checks.rotations_missing_dates.samples).toEqual([{ cycle: 'C1 2026', position: 2 }]);
    expect(checks.rotations_unknown_killer.count).toBe(1);
    expect(checks.podium_threshold_off.count).toBe(1);
    expect(checks.missing_indexes.count).toBeGreaterThan(0);
    expect(checks.duplicate_bbs_names.samples).toEqual([{ bbs_name: 'Ichigo', bbs_ids: ['1', '2'] }]);
    expect(checks.accounts_without_guild.samples).toEqual([{ bbs_id: '2', bbs_name: 'ichigo' }]);
    expect(checks.empty_rotations.count).toBe(0);
  });
});
