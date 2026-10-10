import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import albumsRouter from '../../src/routes/albums.js';

jest.setTimeout(60000);

let mongod;
let client;
let db;
let app;

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');

  app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/api/albums', albumsRouter);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

const tokenFor = (payload) => ({ Authorization: `Bearer ${jwt.sign(payload, process.env.JWT_SECRET)}` });

const seed = async () => {
  const ownerId = new ObjectId();
  const otherId = new ObjectId();
  const characterId = new ObjectId();
  await db.collection('users').insertMany([
    { _id: ownerId, bbs_accounts: [{ bbs_id: 'main1', is_primary: true }, { bbs_id: 'alt1' }] },
    { _id: otherId, bbs_accounts: [{ bbs_id: 'other1', is_primary: true }] },
  ]);
  await db.collection('characters').insertOne({ _id: characterId, name: 'Rangiku' });
  return { ownerId: ownerId.toString(), otherId: otherId.toString(), characterId: characterId.toString() };
};

describe('GET /api/albums/:bbsId', () => {
  it('returns an empty album for an account that never filled it', async () => {
    const res = await request(app).get('/api/albums/main1');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ bbs_id: 'main1', characters: {}, updated_at: null });
  });
});

describe('PUT /api/albums/:bbsId/characters/:characterId', () => {
  it('lets the account owner add, update and remove a character, on an alt too', async () => {
    const { ownerId, characterId } = await seed();
    const url = `/api/albums/alt1/characters/${characterId}`;

    let res = await request(app).put(url).set(tokenFor({ _id: ownerId })).send({ spe: 1 });
    expect(res.status).toBe(200);
    expect(res.body.data.characters).toEqual({ [characterId]: 1 });

    res = await request(app).put(url).set(tokenFor({ _id: ownerId })).send({ spe: 5 });
    expect(res.body.data.characters).toEqual({ [characterId]: 5 });

    res = await request(app).put(url).set(tokenFor({ _id: ownerId })).send({ spe: 0 });
    expect(res.body.data.characters).toEqual({});

    const pub = await request(app).get('/api/albums/alt1');
    expect(pub.body.data.characters).toEqual({});
    expect(await db.collection('albums').countDocuments()).toBe(1);
  });

  it('requires a token', async () => {
    const { characterId } = await seed();
    const res = await request(app).put(`/api/albums/main1/characters/${characterId}`).send({ spe: 1 });
    expect(res.status).toBe(401);
  });

  it("refuses to edit another player's album, but allows admins", async () => {
    const { otherId, characterId } = await seed();
    const url = `/api/albums/main1/characters/${characterId}`;

    const denied = await request(app).put(url).set(tokenFor({ _id: otherId })).send({ spe: 2 });
    expect(denied.status).toBe(403);

    const admin = await request(app).put(url).set(tokenFor({ _id: otherId, is_admin: true })).send({ spe: 2 });
    expect(admin.status).toBe(200);
    expect(admin.body.data.characters).toEqual({ [characterId]: 2 });
  });

  it('rejects an invalid spé, an unknown account or an unknown character', async () => {
    const { ownerId, characterId } = await seed();
    const auth = tokenFor({ _id: ownerId });

    for (const spe of [6, -1, 1.5, 'abc', undefined]) {
      const res = await request(app).put(`/api/albums/main1/characters/${characterId}`).set(auth).send({ spe });
      expect(res.status).toBe(400);
    }
    expect((await request(app).put(`/api/albums/main1/characters/nope`).set(auth).send({ spe: 1 })).status).toBe(400);
    expect((await request(app).put(`/api/albums/ghost/characters/${characterId}`).set(auth).send({ spe: 1 })).status).toBe(404);
    expect((await request(app).put(`/api/albums/main1/characters/${new ObjectId()}`).set(auth).send({ spe: 1 })).status).toBe(404);
  });
});
