import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import recruitmentRouter from '../../src/routes/recruitment.js';

jest.setTimeout(60000);

const JWT_SECRET = 'test-secret';

let mongod;
let client;
let db;
let app;

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  delete process.env.DISCORD_CHANNEL_GLOBAL_CHEF;
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');
  app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/api/recruitment', recruitmentRouter);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

const admin = { Authorization: `Bearer ${jwt.sign({ discord_id: 'admin', is_admin: true }, JWT_SECRET)}` };

describe('recruitment', () => {
  it('lists active guilds with their free places and level', async () => {
    const { insertedIds } = await db.collection('guildes').insertMany([{ name: 'A' }, { name: 'Off', disabled: true }]);
    const guildId = insertedIds[0].toString();
    await db.collection('users').insertMany([
      { bbs_accounts: [{ bbs_id: '1', guilde_id: guildId }] },
      { bbs_accounts: [{ bbs_id: '2', guilde_id: guildId }] },
    ]);
    const { insertedId: cycleId } = await db.collection('cycles').insertOne({ name: 'C', year: 2026, rotations: [{ start_date: '01/09/2026' }] });
    await db.collection('scores').insertMany([
      { cycle_id: cycleId.toString(), guild_id: guildId, score: 600 },
      { cycle_id: cycleId.toString(), guild_id: guildId, score: 400 },
    ]);

    const res = await request(app).get('/api/recruitment');
    expect(res.body.is_open).toBe(true);
    expect(res.body.guilds).toEqual([{ _id: guildId, name: 'A', members: 2, free_places: 28, average_score: 500 }]);
  });

  it('stores an application and lets an admin review it', async () => {
    const sent = await request(app).post('/api/recruitment/applications').send({ bbs_name: 'Ichigo', discord: 'ichigo#1', message: 'Salut' });
    expect(sent.status).toBe(201);

    const list = await request(app).get('/api/recruitment/applications').set(admin);
    expect(list.body.applications).toEqual([expect.objectContaining({ bbs_name: 'Ichigo', status: 'new' })]);

    const reviewed = await request(app).patch(`/api/recruitment/applications/${sent.body._id}`).set(admin).send({ status: 'accepted' });
    expect(reviewed.status).toBe(200);
    expect((await db.collection('applications').findOne({})).status).toBe('accepted');
  });

  it('rejects incomplete, bot and closed-recruitment applications', async () => {
    expect((await request(app).post('/api/recruitment/applications').send({ bbs_name: 'X' })).status).toBe(400);

    const bot = await request(app).post('/api/recruitment/applications').send({ bbs_name: 'X', discord: 'y', website: 'spam' });
    expect(bot.status).toBe(201);
    expect(await db.collection('applications').countDocuments()).toBe(0);

    await request(app).put('/api/recruitment/settings').set(admin).send({ is_open: false, guild_capacity: 30 });
    expect((await request(app).post('/api/recruitment/applications').send({ bbs_name: 'X', discord: 'y' })).status).toBe(403);
  });

  it('keeps applications admin-only', async () => {
    expect((await request(app).get('/api/recruitment/applications')).status).toBe(401);
  });
});
