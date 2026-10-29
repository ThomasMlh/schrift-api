import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import settingsRouter from '../../src/routes/settings.js';

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
  app.use('/api/settings', settingsRouter);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

const tokenFor = (payload) => ({ Authorization: `Bearer ${jwt.sign(payload, process.env.JWT_SECRET)}` });

describe('album option', () => {
  it('is off by default, readable by players and changed by admins only', async () => {
    const playerId = new ObjectId();
    await db.collection('users').insertOne({ _id: playerId, bbs_accounts: [] });
    const player = tokenFor({ _id: playerId.toString() });
    const admin = tokenFor({ _id: new ObjectId().toString(), is_admin: true });

    expect((await request(app).get('/api/settings/albums')).status).toBe(401);
    expect((await request(app).get('/api/settings/albums').set(player)).body.leaders_can_edit).toBe(false);

    expect((await request(app).put('/api/settings/albums').set(player).send({ leaders_can_edit: true })).status).toBe(403);
    expect((await request(app).put('/api/settings/albums').set(admin).send({ leaders_can_edit: 'yes' })).status).toBe(400);
    expect((await request(app).put('/api/settings/albums').set(admin).send({ leaders_can_edit: true })).status).toBe(200);
    expect((await request(app).get('/api/settings/albums').set(player)).body.leaders_can_edit).toBe(true);
  });
});
