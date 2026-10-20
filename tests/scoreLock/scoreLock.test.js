import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import scoresRouter from '../../src/routes/scores/index.js';
import { isCycleLocked } from '../../src/services/scoreLock.js';

jest.setTimeout(60000);

const JWT_SECRET = 'test-secret';
const DAY_MS = 24 * 60 * 60 * 1000;

const fmt = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const cycleEndingOn = (end) => ({ rotations: [{ start_date: fmt(end), end_date: fmt(end) }] });

describe('isCycleLocked', () => {
  const end = new Date(2026, 9, 4);

  it('locks the cycle once the end day and the grace period are over', () => {
    expect(isCycleLocked(cycleEndingOn(end), 3, new Date(2026, 9, 7, 23).getTime())).toBe(false);
    expect(isCycleLocked(cycleEndingOn(end), 3, new Date(2026, 9, 8).getTime())).toBe(true);
  });

  it('never locks when the delay is 0', () => {
    expect(isCycleLocked(cycleEndingOn(end), 0, new Date(2030, 0, 1).getTime())).toBe(false);
  });
});

describe('score writes on a locked cycle', () => {
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

  const seed = async (endsDaysAgo) => {
    const guildId = new ObjectId().toString();
    const end = new Date(Date.now() - endsDaysAgo * DAY_MS);
    const { insertedId } = await db.collection('cycles').insertOne({
      name: 'Cycle', year: end.getFullYear(), rotations: [{ rotation_id: 'r1', position: 1, start_date: fmt(end), end_date: fmt(end) }],
    });
    const { insertedId: playerId } = await db.collection('users').insertOne({ bbs_accounts: [{ bbs_id: 'p1', guilde_id: guildId }] });
    const { insertedId: chefId } = await db.collection('users').insertOne({ bbs_accounts: [{ guilde_id: guildId, role: 'chef' }] });
    const body = { user_id: playerId.toString(), bbs_id: 'p1', cycle_id: insertedId.toString(), rotation_id: 'r1', guild_id: guildId, raw_score: 600000000 };
    return { body, chefToken: jwt.sign({ _id: chefId.toString() }, JWT_SECRET) };
  };

  it('refuses a leader once the cycle is locked', async () => {
    const { body, chefToken } = await seed(10);
    const res = await request(app).post('/api/scores').set('Authorization', `Bearer ${chefToken}`).send(body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CYCLE_LOCKED');
  });

  it('lets a leader write during the grace period', async () => {
    const { body, chefToken } = await seed(1);
    const res = await request(app).post('/api/scores').set('Authorization', `Bearer ${chefToken}`).send(body);
    expect(res.status).toBe(201);
  });

  it('lets an admin write on a locked cycle', async () => {
    const { body } = await seed(10);
    const res = await request(app).post('/api/scores')
      .set('Authorization', `Bearer ${jwt.sign({ discord_id: 'admin', is_admin: true }, JWT_SECRET)}`).send(body);
    expect(res.status).toBe(201);
  });
});
