import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import recruitmentRouter from '../../src/routes/recruitment.js';
import { checkWaitlistPlaces } from '../../src/services/recruitment.js';

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
  // One address per application, so the hourly rate limit does not leak across tests
  app.set('trust proxy', 1);
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

let ipCounter = 0;
const apply = (body) => request(app).post('/api/recruitment/applications').set('X-Forwarded-For', `10.0.0.${++ipCounter}`).send(body);

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
    const sent = await apply({ bbs_name: 'Ichigo', discord: 'ichigo#1', message: 'Salut' });
    expect(sent.status).toBe(201);

    const list = await request(app).get('/api/recruitment/applications').set(admin);
    expect(list.body.applications).toEqual([expect.objectContaining({ bbs_name: 'Ichigo', status: 'new' })]);

    const reviewed = await request(app).patch(`/api/recruitment/applications/${sent.body._id}`).set(admin).send({ status: 'accepted' });
    expect(reviewed.status).toBe(200);
    expect((await db.collection('applications').findOne({})).status).toBe('accepted');
  });

  it('rejects incomplete, bot and closed-recruitment applications', async () => {
    expect((await apply({ bbs_name: 'X' })).status).toBe(400);

    const bot = await apply({ bbs_name: 'X', discord: 'y', website: 'spam' });
    expect(bot.status).toBe(201);
    expect(await db.collection('applications').countDocuments()).toBe(0);

    await request(app).put('/api/recruitment/settings').set(admin).send({ is_open: false, guild_capacity: 30 });
    expect((await apply({ bbs_name: 'X', discord: 'y' })).status).toBe(403);
  });

  it('keeps applications admin-only', async () => {
    expect((await request(app).get('/api/recruitment/applications')).status).toBe(401);
  });

  it('gives the candidate a private tracking link', async () => {
    const sent = await apply({ bbs_name: 'Rukia', discord: 'rukia' });
    expect(sent.body.tracking_token).toEqual(expect.any(String));
    expect(await db.collection('applications').findOne({ tracking_hash: sent.body.tracking_token })).toBeNull();

    const tracked = await request(app).get(`/api/recruitment/track/${sent.body.tracking_token}`);
    expect(tracked.body.application).toMatchObject({ bbs_name: 'Rukia', status: 'new', waitlist_position: null });
    expect(tracked.body.application.discord).toBeUndefined();
    expect((await request(app).get('/api/recruitment/track/wrong')).status).toBe(404);

    const list = await request(app).get('/api/recruitment/applications').set(admin);
    expect(list.body.applications[0].tracking_hash).toBeUndefined();
  });

  it('puts applications on the waiting list when every guild is full', async () => {
    const { insertedId } = await db.collection('guildes').insertOne({ name: 'A' });
    await db.collection('app_settings').insertOne({ _id: 'recruitment', guild_capacity: 1 });
    await db.collection('users').insertOne({ bbs_accounts: [{ bbs_id: '1', guilde_id: insertedId.toString() }] });

    expect((await request(app).get('/api/recruitment')).body.is_full).toBe(true);
    await apply({ bbs_name: 'First', discord: 'a' });
    const second = await apply({ bbs_name: 'Second', discord: 'b' });
    expect(second.body.status).toBe('waitlist');

    const tracked = await request(app).get(`/api/recruitment/track/${second.body.tracking_token}`);
    expect(tracked.body.application.waitlist_position).toBe(2);
  });

  it('warns the leaders once when a place frees up for waiting candidates', async () => {
    process.env.DISCORD_CHANNEL_GLOBAL_CHEF = 'chefs';
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) });
    try {
      const { insertedId } = await db.collection('guildes').insertOne({ name: 'A' });
      await db.collection('app_settings').insertOne({ _id: 'recruitment', guild_capacity: 1 });
      const { insertedId: userId } = await db.collection('users').insertOne({ bbs_accounts: [{ bbs_id: '1', guilde_id: insertedId.toString() }] });
      await db.collection('applications').insertOne({ bbs_name: 'W', status: 'waitlist', created_at: new Date() });

      expect((await checkWaitlistPlaces(db)).alerted).toBe(false);
      await db.collection('users').updateOne({ _id: userId }, { $set: { 'bbs_accounts.0.guilde_id': null } });
      expect((await checkWaitlistPlaces(db)).alerted).toBe(true);
      expect((await checkWaitlistPlaces(db)).alerted).toBe(false);
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body).toMatchObject({ channel_id: 'chefs' });
      expect(body.content).toContain('A (1 place)');

      // Full again, then a new free place: warned again
      await db.collection('users').updateOne({ _id: userId }, { $set: { 'bbs_accounts.0.guilde_id': insertedId.toString() } });
      await checkWaitlistPlaces(db);
      await db.collection('users').updateOne({ _id: userId }, { $set: { 'bbs_accounts.0.guilde_id': null } });
      expect((await checkWaitlistPlaces(db)).alerted).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      delete process.env.DISCORD_CHANNEL_GLOBAL_CHEF;
    }
  });

  it('accepts a candidate into a guild and creates their profile', async () => {
    const { insertedId: guildId } = await db.collection('guildes').insertOne({ name: 'A' });
    const sent = await apply({ bbs_name: 'Renji', bbs_id: '777', discord: 'renji' });

    const noGuild = await request(app).post(`/api/recruitment/applications/${sent.body._id}/accept`).set(admin).send({});
    expect(noGuild.status).toBe(400);

    const accepted = await request(app).post(`/api/recruitment/applications/${sent.body._id}/accept`).set(admin)
      .send({ guild_id: guildId.toString(), create_player: true, welcome_message: 'Bienvenue Renji !' });
    expect(accepted.body).toMatchObject({ success: true, player: { bbs_id: '777' }, welcome: 'no_channel' });

    const user = await db.collection('users').findOne({ 'bbs_accounts.bbs_id': '777' });
    expect(user.bbs_accounts[0]).toMatchObject({ bbs_name: 'Renji', guilde_id: guildId.toString(), role: 'membre' });
    const tracked = await request(app).get(`/api/recruitment/track/${sent.body.tracking_token}`);
    expect(tracked.body.application).toMatchObject({ status: 'accepted', guild_name: 'A' });

    // The bbs account now exists: a second profile cannot be created
    const again = await request(app).post(`/api/recruitment/applications/${sent.body._id}/accept`).set(admin)
      .send({ guild_id: guildId.toString(), create_player: true });
    expect(again.status).toBe(400);
  });
});
