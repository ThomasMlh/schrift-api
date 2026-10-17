import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import guildesRouter from '../../src/routes/guildes/index.js';

// Checks that guild routing works as mounted in index.js (stats before crud), in particular that
// /rankings and /members-summary are NOT caught by GET /:id.
jest.setTimeout(60000);

const JWT_SECRET = 'test-secret';

let mongod;
let client;
let db;
let app;

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');

  app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/api/guildes', guildesRouter);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map(c => db.collection(c.name).deleteMany({})));
});

const adminToken = () => jwt.sign({ id: 'admin-1', is_admin: true }, JWT_SECRET);

describe('GET /api/guildes/rankings (stats.js) is not shadowed by GET /:id (crud.js)', () => {
  it('reaches the rankings handler, not the :id handler', async () => {
    const res = await request(app).get('/api/guildes/rankings');
    // If /:id caught the request, "rankings" would not be a valid ObjectId -> 500; the real handler
    // returns 200 with data: [].
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: [] });
  });
});

describe('GET /api/guildes/members-summary (stats.js) is not shadowed by GET /:id', () => {
  it('reaches the members-summary handler', async () => {
    const res = await request(app).get('/api/guildes/members-summary');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: {} });
  });
});

describe('GET /api/guildes (crud.js)', () => {
  it('lists guilds sorted by name', async () => {
    await db.collection('guildes').insertMany([{ name: 'Zeta' }, { name: 'Alpha' }]);
    const res = await request(app).get('/api/guildes');
    expect(res.status).toBe(200);
    expect(res.body.map(g => g.name)).toEqual(['Alpha', 'Zeta']);
  });
});

describe('GET /api/guildes/:id (crud.js)', () => {
  it('returns 404 for a non-existent guild', async () => {
    const res = await request(app).get(`/api/guildes/${new ObjectId().toString()}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/guildes/:id/stats (stats.js)', () => {
  it('returns 404 for a non-existent guild', async () => {
    const res = await request(app).get(`/api/guildes/${new ObjectId().toString()}/stats`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/guildes/:id/membres (members.js)', () => {
  it('returns an empty roster for a guild with no members', async () => {
    const { insertedId } = await db.collection('guildes').insertOne({ name: 'Test' });
    const res = await request(app).get(`/api/guildes/${insertedId.toString()}/membres`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: [], count: 0 });
  });
});

describe('POST /api/guildes/draft (draft.js, requireAdmin)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).post('/api/guildes/draft').send({ moves: [] });
    expect(res.status).toBe(401);
  });

  it('validates the moves array for an authenticated admin', async () => {
    const res = await request(app)
      .post('/api/guildes/draft')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ moves: [] });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Un tableau de mouvements est requis');
  });
});

describe('PATCH /api/guildes/:id/toggle-disable (crud.js, requireAdmin)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).patch(`/api/guildes/${new ObjectId().toString()}/toggle-disable`);
    expect(res.status).toBe(401);
  });
});
