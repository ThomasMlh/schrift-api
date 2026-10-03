import express from 'express';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import podiumRouter from '../../src/routes/podium.js';

// Tests HTTP de bout en bout sur routes/podium.js, en particulier pour
// vérifier que sendStatusCodeError (src/utils/httpErrors.js) reproduit
// exactement le comportement des 5 blocs catch identiques qu'il remplace :
// même status code, même forme de réponse JSON, sur le chemin succès comme
// sur le chemin erreur métier (statusCode porté par l'Error levée par
// podiumService.js).
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
  app.use('/api/podium', podiumRouter);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map(c => db.collection(c.name).deleteMany({})));
});

describe('GET /api/podium', () => {
  it('returns 400 with the service error message when cycle_id is missing', async () => {
    const res = await request(app).get('/api/podium');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, message: 'Le paramètre cycle_id est obligatoire' });
  });

  it('returns 200 with the podium on a valid cycle_id', async () => {
    const cycle = await db.collection('cycles').insertOne({ name: 'Cycle', year: 2026, rotations: [] });
    const cycleId = cycle.insertedId.toString();
    await db.collection('scores').insertOne({
      cycle_id: cycleId, rotation_id: 'r1', bbs_id: 'bbs-1', bbs_name: 'Alice',
      user_id: 'u1', guild_id: null, score: 100, raw_score: 100,
    });

    const res = await request(app).get('/api/podium').query({ cycle_id: cycleId });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.podium).toHaveLength(1);
    expect(res.body.podium[0].bbs_name).toBe('Alice');
  });
});

describe('GET /api/podium/full', () => {
  it('returns 404 with the service error message for an unknown cycle name', async () => {
    const res = await request(app).get('/api/podium/full').query({ cycle_name: 'Ghost Cycle' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, message: 'Cycle avec le nom "Ghost Cycle" non trouvé' });
  });

  it('returns 400 for an invalid ranking_type', async () => {
    await db.collection('cycles').insertOne({ name: 'Cycle', year: 2026, rotations: [] });
    const res = await request(app).get('/api/podium/full').query({ cycle_name: 'Cycle', ranking_type: 'banana' });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('ranking_type doit être "average", "max" ou "progression"');
  });
});

describe('GET /api/podium/weekly', () => {
  it('returns 400 when week_number is missing', async () => {
    const res = await request(app).get('/api/podium/weekly').query({ cycle_name: 'Cycle' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, message: 'Le paramètre week_number est obligatoire' });
  });
});

describe('GET /api/podium/misses', () => {
  it('returns 200 with an empty result set when there are no misses', async () => {
    await db.collection('cycles').insertOne({ name: 'Cycle', year: 2026, rotations: [] });
    const res = await request(app).get('/api/podium/misses').query({ cycle_name: 'Cycle' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
  });
});
