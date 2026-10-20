import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import authRouter from '../../src/routes/auth.js';
import usersRouter from '../../src/routes/users/index.js';

// A ban must end the session, and ban details stay admin-only.
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
  app.use((req, res, next) => { req.db = db; next(); });
  app.use('/api/auth', authRouter);
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

const adminToken = () => jwt.sign({ discord_id: 'admin-1', is_admin: true }, JWT_SECRET);
const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

const seedLoggedInUser = async (extra = {}) => {
  const refreshToken = jwt.sign({ discord_id: 'player-1', type: 'refresh' }, JWT_SECRET);
  const { insertedId } = await db.collection('users').insertOne({
    discord_id: 'player-1', username: 'player', refresh_token_hash: hash(refreshToken), bbs_accounts: [], ...extra,
  });
  return { userId: insertedId.toString(), refreshToken };
};

describe('ban and session', () => {
  it('revokes the refresh token when a user is banned', async () => {
    const { userId, refreshToken } = await seedLoggedInUser();

    const ban = await request(app)
      .post(`/api/users/${userId}/ban`)
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ reason: 'triche' });
    expect(ban.status).toBe(200);

    const refresh = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(refresh.status).toBe(401);
  });

  it('refuses to refresh the session of a banned user', async () => {
    const { refreshToken } = await seedLoggedInUser({ is_banned: true });

    const refresh = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(refresh.status).toBe(403);
  });
});

describe('ban details visibility', () => {
  it('hides the ban reason and date from non-admins', async () => {
    const { userId } = await seedLoggedInUser({ is_banned: true, ban_reason: 'triche', banned_at: new Date() });

    const anonymous = await request(app).get(`/api/users/${userId}`);
    expect(anonymous.body.user.is_banned).toBe(true);
    expect(anonymous.body.user.ban_reason).toBeUndefined();
    expect(anonymous.body.user.banned_at).toBeUndefined();

    const list = await request(app).get('/api/users').query({ is_banned: 'true' });
    expect(list.body.users[0].ban_reason).toBeUndefined();

    const admin = await request(app).get(`/api/users/${userId}`).set('Authorization', `Bearer ${adminToken()}`);
    expect(admin.body.user.ban_reason).toBe('triche');
  });
});
