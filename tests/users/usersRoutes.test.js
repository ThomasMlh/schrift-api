import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import usersRouter from '../../src/routes/users/index.js';

// users.js (930 lignes, 17 routes) a été découpé en crud.js/roles.js/
// accounts.js/moderation.js + notifications.js (3 helpers Discord partagés
// entre crud.js et roles.js) + un index.js qui les monte. Ces tests
// vérifient que /without-guild et /accounts (crud.js) ne sont pas capturées
// par GET /:userId (même fichier, ordre interne) et que chaque sous-routeur
// répond — aucune route de users.js n'avait de test avant la découpe.
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
  app.use('/api/users', usersRouter);
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

describe('GET /api/users/without-guild (crud.js) is not shadowed by GET /:userId', () => {
  it('reaches the without-guild handler, not the :userId handler', async () => {
    const res = await request(app).get('/api/users/without-guild');
    // Si /:userId capturait la requête, validateObjectIdParam rejetterait
    // "without-guild" avec un 400 ; le vrai handler renvoie 200.
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.users).toEqual([]);
  });
});

describe('GET /api/users/accounts (crud.js) is not shadowed by GET /:userId', () => {
  it('reaches the accounts handler', async () => {
    const res = await request(app).get('/api/users/accounts');
    expect(res.status).toBe(200);
    expect(res.body.users).toEqual([]);
  });

  it('attaches top_achievement to each account (null without any unlocked achievement)', async () => {
    await db.collection('users').insertOne({
      username: 'surimi',
      global_name: 'Surimi',
      bbs_id: '111',
      bbs_name: 'Surimi',
      bbs_accounts: [{ bbs_id: '111', bbs_name: 'Surimi', is_primary: true, guilde_id: null, role: 'membre' }],
    });
    const res = await request(app).get('/api/users/accounts');
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0]).toHaveProperty('top_achievement', null);
  });
});

describe('GET /api/users/:userId (crud.js)', () => {
  it('returns 400 for a malformed id (validateObjectIdParam)', async () => {
    const res = await request(app).get('/api/users/not-an-id');
    expect(res.status).toBe(400);
  });

  it('returns 404 for a well-formed but non-existent id', async () => {
    const res = await request(app).get(`/api/users/${new ObjectId().toString()}`);
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/users/:userId/role (roles.js, requireAdmin)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).put(`/api/users/${new ObjectId().toString()}/role`).send({ role: 'membre' });
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/users/:userId/guild (roles.js, requireAdmin)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).put(`/api/users/${new ObjectId().toString()}/guild`).send({});
    expect(res.status).toBe(401);
  });
});

describe('POST /api/users/:userId/accounts (accounts.js, requireAdmin)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).post(`/api/users/${new ObjectId().toString()}/accounts`).send({});
    expect(res.status).toBe(401);
  });
});

describe('GET /api/users/:user_id/stats (moderation.js)', () => {
  it('surfaces a business error from getUserStats as a non-500', async () => {
    const res = await request(app).get('/api/users/not-an-id/stats');
    // getUserStats lève une erreur avec .statusCode pour un id invalide ;
    // sendHiddenServiceError doit la laisser passer telle quelle (pas 500).
    expect(res.status).not.toBe(500);
  });
});

describe('POST /api/users/:userId/ban (moderation.js, requireAdmin)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).post(`/api/users/${new ObjectId().toString()}/ban`).send({});
    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-existent user when authenticated', async () => {
    const res = await request(app)
      .post(`/api/users/${new ObjectId().toString()}/ban`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({});
    expect(res.status).toBe(404);
  });
});

describe('POST /api/users (crud.js, requireAdmin)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).post('/api/users').send({});
    expect(res.status).toBe(401);
  });

  it('validates discord_id for an authenticated admin', async () => {
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('discord_id requis');
  });
});
