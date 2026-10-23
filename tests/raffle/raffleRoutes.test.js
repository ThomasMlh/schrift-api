import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import raffleRouter from '../../src/routes/raffle.js';

jest.setTimeout(60000);

const JWT_SECRET = 'test-secret';

let mongod;
let client;
let app;

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  app = express();
  app.use(express.json());
  app.locals.db = client.db('schrift-test');
  app.use('/api/raffle', raffleRouter);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

const bearer = (payload) => ({ Authorization: `Bearer ${jwt.sign(payload, JWT_SECRET)}` });

describe('raffle routes', () => {
  it('are reserved to admins', async () => {
    expect((await request(app).get('/api/raffle')).status).toBe(401);
    const leader = await request(app).get('/api/raffle').set(bearer({ discord_id: 'chef', is_admin: false }));
    expect(leader.status).toBe(403);
    const admin = await request(app).get('/api/raffle').set(bearer({ discord_id: 'admin', is_admin: true }));
    expect(admin.status).toBe(200);
    expect(admin.body).toMatchObject({ success: true, guild_ids: [], max_tickets: 20 });
  });
});
