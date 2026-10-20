import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import usersRouter from '../../src/routes/users/index.js';
import { keepBbsIds } from '../../src/services/podiumService/index.js';

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
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

const seed = async () => {
  const { insertedId: meId } = await db.collection('users').insertOne({ bbs_accounts: [{ bbs_id: 'me' }] });
  await db.collection('users').insertOne({ global_name: 'Rival', bbs_accounts: [{ bbs_id: 'rival', bbs_name: 'RIVAL' }] });
  return { Authorization: `Bearer ${jwt.sign({ _id: meId.toString() }, JWT_SECRET)}` };
};

describe('followed players', () => {
  it('follows, lists and unfollows an account', async () => {
    const auth = await seed();

    expect((await request(app).put('/api/users/me/following/rival').set(auth)).status).toBe(200);
    const list = await request(app).get('/api/users/me/following').set(auth);
    expect(list.body.following).toEqual([expect.objectContaining({ bbs_id: 'rival', bbs_name: 'RIVAL', global_name: 'Rival' })]);

    const removed = await request(app).delete('/api/users/me/following/rival').set(auth);
    expect(removed.body.following).toEqual([]);
  });

  it('refuses unknown accounts and the user\'s own account', async () => {
    const auth = await seed();
    expect((await request(app).put('/api/users/me/following/nobody').set(auth)).status).toBe(404);
    expect((await request(app).put('/api/users/me/following/me').set(auth)).status).toBe(400);
  });

  it('requires a login', async () => {
    expect((await request(app).get('/api/users/me/following')).status).toBe(401);
  });
});

describe('keepBbsIds', () => {
  it('keeps the listed accounts with their overall rank, or everything without a filter', () => {
    const ranked = [{ rank: 1, bbs_id: 'a' }, { rank: 2, bbs_id: 'b' }, { rank: 3, bbs_id: 'c' }];
    expect(keepBbsIds(ranked, 'c,a')).toEqual([{ rank: 1, bbs_id: 'a' }, { rank: 3, bbs_id: 'c' }]);
    expect(keepBbsIds(ranked, '')).toEqual([]);
    expect(keepBbsIds(ranked, undefined)).toBe(ranked);
  });
});
