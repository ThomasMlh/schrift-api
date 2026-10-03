import express from 'express';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import rotationsRouter from '../../src/routes/rotations.js';
import usersRouter from '../../src/routes/users/index.js';

// Routes publiques exposant les records : historique d'un killer (page de rotation) et records
// personnels d'un joueur (page profil). La logique de calcul est couverte par
// killerRecords.test.js ; ici on vérifie le câblage HTTP et les paramètres.
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
  app.use('/api/users', usersRouter);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

const seed = async () => {
  const { insertedId: rotationId } = await db.collection('rotations').insertOne({ killer: 'Arrancar', attack: 'R', alteration: 'Gel' });
  const rotation = rotationId.toString();
  const { insertedId: c1 } = await db.collection('cycles').insertOne({ name: 'C1', year: 2026, rotations: [{ rotation_id: rotation, start_date: '01/01/2026' }] });
  const { insertedId: c2 } = await db.collection('cycles').insertOne({ name: 'C2', year: 2026, rotations: [{ rotation_id: rotation, start_date: '01/03/2026' }] });
  await db.collection('scores').insertMany([
    { cycle_id: c1.toString(), rotation_id: rotation, bbs_id: 'bbs-1', bbs_name: 'Alice', guild_id: 'g1', score: 100, raw_score: 100, is_differential: false },
    { cycle_id: c2.toString(), rotation_id: rotation, bbs_id: 'bbs-1', bbs_name: 'Alice', guild_id: 'g1', score: 250, raw_score: 250, is_differential: false },
  ]);
  return { rotation, c1: c1.toString(), c2: c2.toString() };
};

describe('GET /api/rotations/:id/history', () => {
  it('returns the killer history with the record to beat for the given cycle', async () => {
    const { rotation, c2 } = await seed();

    const res = await request(app).get(`/api/rotations/${rotation}/history`).query({ guild_id: 'g1', cycle_id: c2 });

    expect(res.status).toBe(200);
    expect(res.body.data.absolute_record).toMatchObject({ score: 250, bbs_name: 'Alice' });
    expect(res.body.data.record_to_beat).toMatchObject({ score: 100, cycle_name: 'C1' });
    expect(res.body.data.per_cycle.map((c) => c.cycle_name)).toEqual(['C1', 'C2']);
  });

  it('returns an empty history for a killer with no score', async () => {
    const res = await request(app).get(`/api/rotations/${new ObjectId().toString()}/history`);
    expect(res.status).toBe(200);
    expect(res.body.data.absolute_record).toBeNull();
  });
});

describe('GET /api/users/:userId/records', () => {
  it('returns the best score per killer for each of the user bbs accounts', async () => {
    await seed();
    const { insertedId } = await db.collection('users').insertOne({
      discord_id: 'd1',
      bbs_accounts: [{ bbs_id: 'bbs-1', bbs_name: 'Alice', is_primary: true }],
    });

    const res = await request(app).get(`/api/users/${insertedId.toString()}/records`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({
        bbs_id: 'bbs-1',
        is_primary: true,
        records: [expect.objectContaining({ killer: 'Arrancar', score: 250, attempts: 2 })],
      }),
    ]);
  });

  it('returns 404 for an unknown user and 400 for a malformed id', async () => {
    expect((await request(app).get(`/api/users/${new ObjectId().toString()}/records`)).status).toBe(404);
    expect((await request(app).get('/api/users/not-an-id/records')).status).toBe(400);
  });
});
