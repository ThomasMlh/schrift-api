import express from 'express';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import rotationsRouter from '../src/routes/rotations.js';

jest.setTimeout(60000);

let mongod;
let client;
let db;
let app;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');
  app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/api/rotations', rotationsRouter);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

const score = (cycleId, rotation, bbsId, name, value, guild = 'g1') => ({
  cycle_id: cycleId, rotation_id: rotation, bbs_id: bbsId, bbs_name: name, guild_id: guild, user_id: bbsId,
  score: value, raw_score: value, is_differential: false,
});

// Three passages of the rotation: C1 then C2 then C3 (by first rotation date), inserted out of order
const seed = async () => {
  const rotation = new ObjectId().toString();
  const other = new ObjectId().toString();
  const cycle = async (name, start) => (await db.collection('cycles').insertOne({
    name, year: 2026, rotations: [{ rotation_id: rotation, start_date: start }],
  })).insertedId.toString();
  const c3 = await cycle('C3', '01/06/2026');
  const c1 = await cycle('C1', '01/01/2026');
  const c2 = await cycle('C2', '01/03/2026');
  const { insertedId: guild } = await db.collection('guildes').insertOne({ name: 'Alpha' });
  await db.collection('scores').insertMany([
    score(c1, rotation, 'a', 'Alice', 100, guild.toString()),
    score(c2, rotation, 'a', 'Alice', 300, guild.toString()),
    score(c3, rotation, 'a', 'Alice', 250, guild.toString()),
    score(c1, rotation, 'b', 'Bob', 200, 'g2'),
    score(c3, rotation, 'b', 'Bob', 250, 'g2'),
    score(c3, rotation, 'c', 'Cid', 90, 'g2'),
    score(c3, other, 'c', 'Cid', 999, 'g2'),
  ]);
  return { rotation, c1, c2, c3, guild: guild.toString() };
};

describe('GET /api/rotations/:id/scores', () => {
  it('ranks a cycle with ties and gives each player its last earlier passage', async () => {
    const { rotation, c1, c2, c3 } = await seed();
    const res = await request(app).get(`/api/rotations/${rotation}/scores`).query({ cycle_id: c3 });
    expect(res.status).toBe(200);
    expect(res.body.data.map((s) => [s.bbs_name, s.rank])).toEqual([['Alice', 1], ['Bob', 1], ['Cid', 3]]);
    const byName = Object.fromEntries(res.body.data.map((s) => [s.bbs_name, s.previous]));
    // Alice played C1 and C2: the latest earlier one counts; Bob skipped C2
    expect(byName.Alice).toMatchObject({ score: 300, cycle_id: c2, cycle_name: 'C2' });
    expect(byName.Bob).toMatchObject({ score: 200, cycle_id: c1 });
    expect(byName.Cid).toBeNull();
    expect(res.body.pagination.totalCount).toBe(3);
  });

  it('filters by guild and answers 404 for a cycle without the rotation', async () => {
    const { rotation, c3, guild } = await seed();
    const res = await request(app).get(`/api/rotations/${rotation}/scores`).query({ cycle_id: c3, guild_id: guild });
    expect(res.body.data.map((s) => s.bbs_name)).toEqual(['Alice']);
    const otherCycle = (await db.collection('cycles').insertOne({ name: 'X', rotations: [] })).insertedId.toString();
    expect((await request(app).get(`/api/rotations/${rotation}/scores`).query({ cycle_id: otherCycle })).status).toBe(404);
    expect((await request(app).get(`/api/rotations/${rotation}/scores`)).status).toBe(400);
  });
});

describe('GET /api/rotations/:id/records', () => {
  it('keeps the best score of each player with its cycle and passage count', async () => {
    const { rotation, c2, guild } = await seed();
    const res = await request(app).get(`/api/rotations/${rotation}/records`);
    expect(res.body.data.map((r) => [r.bbs_name, r.score, r.rank, r.passages])).toEqual([
      ['Alice', 300, 1, 3], ['Bob', 250, 2, 2], ['Cid', 90, 3, 1],
    ]);
    expect(res.body.data[0]).toMatchObject({ cycle_id: c2, cycle_name: 'C2', guild_name: 'Alpha' });
    const scoped = await request(app).get(`/api/rotations/${rotation}/records`).query({ guild_id: guild });
    expect(scoped.body.data.map((r) => r.bbs_name)).toEqual(['Alice']);
  });
});

describe('GET /api/rotations/:id/history', () => {
  it('gives the best score of each passage', async () => {
    const { rotation } = await seed();
    const res = await request(app).get(`/api/rotations/${rotation}/history`);
    expect(res.body.data.per_cycle.map((c) => [c.cycle_name, c.best])).toEqual([['C1', 200], ['C2', 300], ['C3', 250]]);
  });
});
