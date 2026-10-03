import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import scoresRouter from '../../src/routes/scores/index.js';
import podiumRouter from '../../src/routes/podium.js';
import cronRouter from '../../src/routes/cron.js';
import settingsRouter from '../../src/routes/settings.js';

// Câblage HTTP des tendances : droits d'accès aux baisses de régime (admin / chef limité à sa
// guilde), protection du cron par CRON_SECRET, réglage de l'envoi automatique du récap et aperçu
// du récap. La logique de calcul est couverte par playerTrends.test.js.
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
  app.use('/api/scores', scoresRouter);
  app.use('/api/podium', podiumRouter);
  app.use('/api/cron', cronRouter);
  app.use('/api/settings', settingsRouter);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  delete process.env.CRON_SECRET;
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

const adminToken = () => jwt.sign({ id: 'admin-1', is_admin: true }, JWT_SECRET);
const chefToken = (guildId) => jwt.sign({ id: 'chef-1', role: 'chef', guild_roles: [{ guilde_id: guildId, role: 'chef' }] }, JWT_SECRET);
const memberToken = () => jwt.sign({ id: 'member-1' }, JWT_SECRET);

// Une guilde dont un membre (alice) s'effondre sur le dernier cycle
const seedDecline = async (guildName) => {
  const { insertedId } = await db.collection('guildes').insertOne({ name: guildName });
  const guildId = insertedId.toString();
  const bbs = `${guildName}-alice`;
  await db.collection('users').insertOne({ discord_id: `d-${bbs}`, bbs_accounts: [{ bbs_id: bbs, guilde_id: guildId }] });
  const { insertedIds } = await db.collection('rotations').insertMany([{ killer: 'A' }, { killer: 'B' }]);
  const rotations = Object.values(insertedIds).map((id) => id.toString());
  const cycleIds = [];
  for (const [name, date] of [['C1', '01/01/2026'], ['C2', '01/03/2026']]) {
    const { insertedId: cycleId } = await db.collection('cycles').insertOne({
      name: `${guildName}-${name}`, year: 2026, rotations: rotations.map((rotation_id, i) => ({ rotation_id, position: i + 1, start_date: date })),
    });
    cycleIds.push(cycleId.toString());
  }
  await db.collection('scores').insertMany(rotations.flatMap((rotation_id) => [
    { cycle_id: cycleIds[0], rotation_id, bbs_id: bbs, bbs_name: bbs, guild_id: guildId, score: 100, is_differential: false },
    { cycle_id: cycleIds[1], rotation_id, bbs_id: bbs, bbs_name: bbs, guild_id: guildId, score: 10, is_differential: false },
  ]));
  return guildId;
};

describe('GET /api/scores/decline-alerts', () => {
  it('rejects members who are neither admin nor chef', async () => {
    const res = await request(app).get('/api/scores/decline-alerts').set('Authorization', `Bearer ${memberToken()}`);
    expect(res.status).toBe(403);
  });

  it('gives admins every active guild', async () => {
    await seedDecline('g1');
    await seedDecline('g2');
    const res = await request(app).get('/api/scores/decline-alerts').set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.alerts.map((a) => a.bbs_id).sort()).toEqual(['g1-alice', 'g2-alice']);
  });

  it('limits a chef to their own guild and refuses another one', async () => {
    const own = await seedDecline('g1');
    const other = await seedDecline('g2');

    const res = await request(app).get('/api/scores/decline-alerts').set('Authorization', `Bearer ${chefToken(own)}`);
    expect(res.status).toBe(200);
    expect(res.body.alerts.map((a) => a.bbs_id)).toEqual(['g1-alice']);

    const forbidden = await request(app).get('/api/scores/decline-alerts').query({ guild_id: other })
      .set('Authorization', `Bearer ${chefToken(own)}`);
    expect(forbidden.status).toBe(403);
  });
});

describe('GET /api/cron/cycle-recap', () => {
  it('fails closed when CRON_SECRET is not configured', async () => {
    const res = await request(app).get('/api/cron/cycle-recap');
    expect(res.status).toBe(503);
  });

  it('rejects a wrong secret and runs with the right one', async () => {
    process.env.CRON_SECRET = 'cron-secret';
    expect((await request(app).get('/api/cron/cycle-recap').set('Authorization', 'Bearer nope')).status).toBe(401);

    const res = await request(app).get('/api/cron/cycle-recap').set('Authorization', 'Bearer cron-secret');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, enabled: false, published: [] });
  });
});

describe('PUT /api/settings/podium', () => {
  it('toggles the automatic cycle recap without touching the score threshold', async () => {
    await db.collection('app_settings').insertOne({ _id: 'podium', min_scores_for_ranking: 5 });

    const res = await request(app).put('/api/settings/podium').set('Authorization', `Bearer ${adminToken()}`)
      .send({ auto_cycle_recap: true });
    expect(res.status).toBe(200);

    const get = await request(app).get('/api/settings/podium').set('Authorization', `Bearer ${adminToken()}`);
    expect(get.body).toMatchObject({ min_scores_for_ranking: 5, auto_cycle_recap: true });
  });

  it('rejects a non-boolean toggle and an empty update', async () => {
    const auth = { Authorization: `Bearer ${adminToken()}` };
    expect((await request(app).put('/api/settings/podium').set(auth).send({ auto_cycle_recap: 'yes' })).status).toBe(400);
    expect((await request(app).put('/api/settings/podium').set(auth).send({})).status).toBe(400);
  });
});

describe('GET /api/podium/cycle-recap', () => {
  it('requires admin and valid ids', async () => {
    expect((await request(app).get('/api/podium/cycle-recap')).status).toBe(401);
    const res = await request(app).get('/api/podium/cycle-recap').query({ cycle_id: 'x', guild_id: 'y' })
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(400);
  });

  it('returns the recap preview of a guild', async () => {
    const guildId = await seedDecline('g1');
    const cycle = await db.collection('cycles').findOne({ name: 'g1-C2' });
    const res = await request(app).get('/api/podium/cycle-recap').query({ cycle_id: cycle._id.toString(), guild_id: guildId })
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.recap).toMatchObject({ guild_name: 'g1', cycle_name: 'g1-C2', previous_cycle_name: 'g1-C1', guild_average: 10, previous_guild_average: 100 });
  });

  it('returns 404 for an unknown cycle', async () => {
    const res = await request(app).get('/api/podium/cycle-recap')
      .query({ cycle_id: new ObjectId().toString(), guild_id: new ObjectId().toString() })
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(404);
  });
});
