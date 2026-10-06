import express from 'express';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import jwt from 'jsonwebtoken';
import { MongoClient, ObjectId } from 'mongodb';
import buildsRouter from '../../src/routes/builds/index.js';

// builds.js (944 lignes, 6 routes mais 2 handlers de ~275 lignes chacun) a
// été découpé en create.js/crud.js/update.js + enrich.js (3 helpers
// d'enrichissement partagés). Ces tests vérifient que les 3 sous-routeurs
// sont bien câblés et que l'enrichissement partagé fonctionne après la
// découpe — aucune route de builds.js n'avait de test avant.
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
  app.use('/api/builds', buildsRouter);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map(c => db.collection(c.name).deleteMany({})));
});

describe('POST /api/builds (create.js)', () => {
  it('requires rotation_id', async () => {
    const res = await request(app).post('/api/builds').send({ team: [] });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Le rotation_id est obligatoire');
  });

  it('requires a non-empty team', async () => {
    const { insertedId } = await db.collection('rotations').insertOne({ killer: 'X', attack: 'R' });
    const res = await request(app).post('/api/builds').send({ rotation_id: insertedId.toString(), team: [] });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('La team est obligatoire et doit contenir au moins un personnage');
  });

  it('creates a build and enriches the team with character data', async () => {
    const { insertedId: rotationId } = await db.collection('rotations').insertOne({ killer: 'X', attack: 'R' });
    const { insertedId: characterId } = await db.collection('characters').insertOne({ name: 'Ichigo', rarity: 'UR' });

    const res = await request(app).post('/api/builds').send({
      rotation_id: rotationId.toString(),
      team: [{ id_character: characterId.toString(), position: 1 }],
    });

    expect(res.status).toBe(201);
    expect(res.body.data.team[0].character.name).toBe('Ichigo');
    expect(res.body.data.rotation.killer).toBe('X');
  });
});

describe('GET /api/builds (crud.js)', () => {
  it('returns an empty list with pagination metadata when there are no builds', async () => {
    const res = await request(app).get('/api/builds');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});

describe('GET /api/builds/:id (crud.js)', () => {
  it('returns 404 for a non-existent build', async () => {
    const res = await request(app).get(`/api/builds/${new ObjectId().toString()}`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/builds/:id (update.js)', () => {
  it('requires authentication', async () => {
    const { insertedId } = await db.collection('builds').insertOne({
      rotation_id: 'r1', team: [], user_id: null, isValid: false,
    });
    const res = await request(app).patch(`/api/builds/${insertedId.toString()}`).send({ description: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/builds/:id/validate (update.js, requireAdmin)', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app)
      .patch(`/api/builds/${new ObjectId().toString()}/validate`)
      .send({ isValid: true });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/builds/:id (crud.js, requireAdmin)', () => {
  const adminAuth = () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    return { Authorization: `Bearer ${jwt.sign({ id: 'admin-1', is_admin: true }, process.env.JWT_SECRET)}` };
  };

  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).delete(`/api/builds/${new ObjectId().toString()}`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-existent build', async () => {
    const res = await request(app).delete(`/api/builds/${new ObjectId().toString()}`).set(adminAuth());
    expect(res.status).toBe(404);
  });

  it('deletes an existing build', async () => {
    const { insertedId } = await db.collection('builds').insertOne({
      rotation_id: 'r1', team: [], user_id: null, isValid: false,
    });
    const res = await request(app).delete(`/api/builds/${insertedId.toString()}`).set(adminAuth());
    expect(res.status).toBe(200);
    expect(await db.collection('builds').findOne({ _id: insertedId })).toBeNull();
  });
});
