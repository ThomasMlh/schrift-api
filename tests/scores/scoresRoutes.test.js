import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import scoresRouter from '../../src/routes/scores/index.js';

// scores.js (1429 lignes, 11 routes) a été découpé en crud.js/bulk.js/
// transfers.js + un index.js qui les monte. Aucune de ces routes n'avait de
// test avant la découpe : ces tests vérifient que les 3 sous-routeurs sont
// bien câblés au même routeur (mêmes chemins, même middleware requireDb,
// mêmes middlewares d'auth par route) — pas une couverture exhaustive de la
// logique métier de scores.js, qui reste à faire séparément.
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
  app.use('/api/scores', scoresRouter);
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

describe('GET /api/scores (crud.js)', () => {
  it('returns an empty list with pagination metadata when there are no scores', async () => {
    const res = await request(app).get('/api/scores');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.totalCount).toBe(0);
  });

  it('returns a score by id', async () => {
    const { insertedId } = await db.collection('scores').insertOne({
      cycle_id: 'c1', rotation_id: 'r1', bbs_id: 'bbs-1', bbs_name: 'Alice',
      user_id: 'u1', guild_id: null, score: 100, raw_score: 100,
    });
    const res = await request(app).get(`/api/scores/${insertedId.toString()}`);
    expect(res.status).toBe(200);
    expect(res.body.score.bbs_name).toBe('Alice');
  });

  it('returns 404 for a well-formed but non-existent id', async () => {
    const res = await request(app).get(`/api/scores/${new ObjectId().toString()}`);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, message: 'Score non trouvé' });
  });
});

describe('POST /api/scores (crud.js, requireScoresAccess)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).post('/api/scores').send({});
    expect(res.status).toBe(401);
  });

  it('validates required fields for an authenticated admin', async () => {
    const res = await request(app)
      .post('/api/scores')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/scores/bulk (bulk.js, requireScoresAccess)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).post('/api/scores/bulk').send([]);
    expect(res.status).toBe(401);
  });

  it('rejects a non-array body for an authenticated admin', async () => {
    const res = await request(app)
      .post('/api/scores/bulk')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Un tableau de scores est requis');
  });
});

describe('POST /api/scores/transfer-rotation (transfers.js, requireScoresAccess)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).post('/api/scores/transfer-rotation').send({});
    expect(res.status).toBe(401);
  });

  it('validates required fields for an authenticated admin', async () => {
    const res = await request(app)
      .post('/api/scores/transfer-rotation')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('cycle_id, source_rotation_id et target_rotation_id sont requis');
  });
});

describe('PUT /api/scores/:id/transfer-account (transfers.js, requireScoresAccess)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).put(`/api/scores/${new ObjectId().toString()}/transfer-account`).send({});
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/scores/:id (crud.js, requireScoresAccess)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).delete(`/api/scores/${new ObjectId().toString()}`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-existent score', async () => {
    const res = await request(app)
      .delete(`/api/scores/${new ObjectId().toString()}`)
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(404);
  });

  it('refuses a chef deleting a score of another guild', async () => {
    const { insertedId } = await db.collection('scores').insertOne({
      cycle_id: 'c1', rotation_id: 'r1', bbs_id: 'bbs-1', guild_id: 'other-guild', score: 100, raw_score: 100,
    });
    const chefToken = jwt.sign({ id: 'chef-1', guild_roles: [{ guilde_id: 'my-guild', role: 'chef' }] }, JWT_SECRET);
    const res = await request(app)
      .delete(`/api/scores/${insertedId.toString()}`)
      .set('Authorization', `Bearer ${chefToken}`);
    expect(res.status).toBe(403);
    expect(await db.collection('scores').countDocuments()).toBe(1);
  });
});
