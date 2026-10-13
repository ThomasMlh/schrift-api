import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { getBulkEntryContext } from '../../src/services/bulkEntryContext.js';

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

afterEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

const rotations = (ids, month) => ids.map((rotation_id, i) => ({
  rotation_id, position: i + 1, start_date: `0${i + 1}/${month}/2026`, end_date: `0${i + 2}/${month}/2026`,
}));

const makeCycle = async (name, ids, month) => {
  const { insertedId } = await db.collection('cycles').insertOne({ name, rotations: rotations(ids, month), created_at: new Date() });
  return insertedId.toString();
};

const score = (cycleId, rotationId, bbsId, value, extra = {}) =>
  ({ cycle_id: cycleId, rotation_id: rotationId, bbs_id: bbsId, score: value, raw_score: value, ...extra });

describe('getBulkEntryContext', () => {
  it('gives the usual score of each account on the killer', async () => {
    const old1 = await makeCycle('C1', ['quincy', 'hollow'], '01');
    const old2 = await makeCycle('C2', ['quincy', 'hollow'], '02');
    const current = await makeCycle('C3', ['quincy', 'hollow'], '03');
    await db.collection('scores').insertMany([
      score(old1, 'quincy', 'p1', 100),
      score(old2, 'quincy', 'p1', 300),
      score(old2, 'hollow', 'p1', 999, { is_differential: true }),
    ]);

    const context = await getBulkEntryContext(db, { cycleId: current, rotationId: 'quincy', bbsIds: ['p1', 'p2'] });

    expect(context.is_differential).toBe(false);
    expect(context.thresholds).toEqual({ above: 2, below: 0.25 });
    expect(context.accounts).toEqual({
      p1: { usual_score: 200, base_raw: null },
      p2: { usual_score: null, base_raw: null },
    });
  });

  it('gives the base raw score of the week on a differential rotation', async () => {
    const current = await makeCycle('C1', ['quincy', 'hollow'], '03');
    await db.collection('scores').insertOne(score(current, 'quincy', 'p1', 500));

    const context = await getBulkEntryContext(db, { cycleId: current, rotationId: 'hollow', bbsIds: ['p1'] });

    expect(context.is_differential).toBe(true);
    expect(context.accounts.p1.base_raw).toBe(500);
  });

  it('rejects a rotation that is not part of the cycle', async () => {
    const current = await makeCycle('C1', ['quincy'], '03');
    await expect(getBulkEntryContext(db, { cycleId: current, rotationId: 'ghost', bbsIds: [] }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});
