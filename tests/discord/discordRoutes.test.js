import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import discordRouter from '../../src/routes/discord.js';

// Nouvelle fonctionnalité : lister les salons Discord (+ leurs membres) et envoyer un
// message via le bot, depuis le site. Admin : tous les salons. Chef/sous-chef : limité
// aux salons (chefs + général) des guildes qu'il gère (cf. getAllowedChannelIds dans
// routes/discord.js). Le bot lui-même est mocké via global.fetch — ces tests vérifient
// la logique de filtrage/permission côté API, pas le bot.
jest.setTimeout(60000);

const JWT_SECRET = 'test-secret';
const MOCK_CHANNELS = [
  { id: 'chan-guild-a-chefs', name: 'guilde-a-chefs', guild_id: 'g1', guild_name: 'Discord', members: [{ id: 'u1', username: 'alice', display_name: 'Alice' }] },
  { id: 'chan-guild-a-general', name: 'guilde-a-general', guild_id: 'g1', guild_name: 'Discord', members: [{ id: 'u1', username: 'alice', display_name: 'Alice' }, { id: 'u2', username: 'bob', display_name: 'Bob' }] },
  { id: 'chan-guild-b-chefs', name: 'guilde-b-chefs', guild_id: 'g1', guild_name: 'Discord', members: [{ id: 'u3', username: 'carol', display_name: 'Carol' }] },
  { id: 'chan-unrelated', name: 'annonces', guild_id: 'g1', guild_name: 'Discord', members: [] },
];

let mongod;
let client;
let db;
let app;
let originalFetch;

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.BOT_WEBHOOK_SECRET = 'bot-secret';
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');

  app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/api/discord', discordRouter);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

beforeEach(() => {
  originalFetch = global.fetch;
  global.fetch = jest.fn(async (url) => {
    if (String(url).includes('/channels')) {
      return { ok: true, status: 200, json: async () => ({ channels: MOCK_CHANNELS }) };
    }
    if (String(url).includes('/send-message')) {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', message_id: 'm1', channel: 'chan-guild-a-chefs' }) };
    }
    throw new Error(`unexpected fetch to ${url}`);
  });
});

afterEach(async () => {
  global.fetch = originalFetch;
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

const adminToken = () => jwt.sign({ id: 'admin-1', is_admin: true }, JWT_SECRET);
const chefTokenFor = (guildeId) =>
  jwt.sign({ id: 'chef-1', guild_roles: [{ bbs_id: 'bbs-chef', guilde_id: guildeId, role: 'chef' }] }, JWT_SECRET);

describe('GET /api/discord/channels', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).get('/api/discord/channels');
    expect(res.status).toBe(401);
  });

  it('returns every channel for an admin', async () => {
    const res = await request(app).get('/api/discord/channels').set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
    expect(res.body.channels).toHaveLength(4);
  });

  it('returns only the channels of the chef\'s guild', async () => {
    const guild = await db.collection('guildes').insertOne({
      name: 'Guilde A',
      discord_channel_id: 'chan-guild-a-chefs',
      discord_general_channel_id: 'chan-guild-a-general',
    });

    const res = await request(app)
      .get('/api/discord/channels')
      .set('Authorization', `Bearer ${chefTokenFor(guild.insertedId.toString())}`);

    expect(res.status).toBe(200);
    expect(res.body.channels.map((c) => c.id).sort()).toEqual(['chan-guild-a-chefs', 'chan-guild-a-general']);
  });

  it('returns an empty list for a chef whose guild has no registered Discord channels', async () => {
    const guild = await db.collection('guildes').insertOne({ name: 'Guilde Sans Discord' });

    const res = await request(app)
      .get('/api/discord/channels')
      .set('Authorization', `Bearer ${chefTokenFor(guild.insertedId.toString())}`);

    expect(res.status).toBe(200);
    expect(res.body.channels).toEqual([]);
  });
});

describe('POST /api/discord/messages', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(app).post('/api/discord/messages').send({});
    expect(res.status).toBe(401);
  });

  it('validates required fields', async () => {
    const res = await request(app)
      .post('/api/discord/messages')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('channel_id requis');
  });

  it('lets an admin send to any channel', async () => {
    const res = await request(app)
      .post('/api/discord/messages')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ channel_id: 'chan-unrelated', content: 'Salut tout le monde' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/send-message'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('lets a chef send to their own guild\'s channel', async () => {
    const guild = await db.collection('guildes').insertOne({
      name: 'Guilde A',
      discord_channel_id: 'chan-guild-a-chefs',
      discord_general_channel_id: 'chan-guild-a-general',
    });

    const res = await request(app)
      .post('/api/discord/messages')
      .set('Authorization', `Bearer ${chefTokenFor(guild.insertedId.toString())}`)
      .send({ channel_id: 'chan-guild-a-general', content: 'Salut la guilde, <@u2> stp regarde ça', mention_user_ids: ['u2'] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('forbids a chef from sending to a channel outside their guild', async () => {
    const guild = await db.collection('guildes').insertOne({
      name: 'Guilde A',
      discord_channel_id: 'chan-guild-a-chefs',
      discord_general_channel_id: 'chan-guild-a-general',
    });

    const res = await request(app)
      .post('/api/discord/messages')
      .set('Authorization', `Bearer ${chefTokenFor(guild.insertedId.toString())}`)
      .send({ channel_id: 'chan-guild-b-chefs', content: 'Message pas pour moi' });

    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('surfaces a 404 from the bot (e.g. channel no longer exists)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: 'Channel introuvable' }) });

    const res = await request(app)
      .post('/api/discord/messages')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ channel_id: new ObjectId().toString(), content: 'Salut' });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Channel introuvable');
  });
});
