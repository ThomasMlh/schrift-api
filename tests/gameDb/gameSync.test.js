import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import charactersRouter from '../../src/routes/characters.js';
import { GAME_TABLES } from '../../src/services/gameDb/buildCharacters.js';

jest.setTimeout(60000);

const JWT_SECRET = 'test-secret';
const bearer = (payload) => ({ Authorization: `Bearer ${jwt.sign(payload, JWT_SECRET)}` });

const csv = (rows) => {
  const header = [...new Set(rows.flatMap(Object.keys))];
  const cell = (value) => (/[",\n]/.test(value ?? '') ? `"${String(value).replace(/"/g, '""')}"` : (value ?? ''));
  return [header.join(','), ...rows.map((row) => header.map((key) => cell(row[key])).join(','))].join('\n');
};

const unit = (id, visual, name, element) => ({
  id, name: `lb_${name}`, full_name: `lb_${name}`, resource_2d_id: visual, resource_3d_id: 'mdl', rarity: '6', is_resurrect: '0',
  character_category: 'normal', character_element: element, third_max_hp: '1000', third_max_sp: '800', third_max_atk: '600',
  third_max_def: '300', third_max_crt: '300', killer_type1: 'hollow', start_date: '2025-01-01 16:00:00',
});

const TABLES = {
  m_character: [unit('61001', '0001', 'ICG', '3'), unit('65115', '2000', 'ICG2', '4')],
  m_dictionary: [{ dictkey: 'lb_ICG', content_fr: 'Ichigo Kurosaki' }, { dictkey: 'lb_ICG2', content_fr: 'Ichigo Refine' }],
  m_resource_3d: [{ id: 'mdl', belong_type_1: 'soul_reaper' }],
};

let mongod;
let client;
let db;
let app;
let dir;
const siteId = new ObjectId();

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  dir = mkdtempSync(join(tmpdir(), 'game-db-'));
  for (const name of GAME_TABLES) writeFileSync(join(dir, `${name}.csv`), csv(TABLES[name] ?? [{ id: '' }]));
  process.env.GAME_DB_DIR = dir;

  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');
  await db.collection('characters').insertOne({
    _id: siteId, name: 'Ichigo Kurosaki', search_name: 'Ichigo Bankai', version_name: 'Bankai', affinity: 'Force',
    release_date: '30/12/2024', source_images: { thumbnail: 'https://bucket.bbs-simulator.com/character/0001-x.png' },
  });
  app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/api/characters', charactersRouter);
});

afterAll(async () => {
  delete process.env.GAME_DB_DIR;
  rmSync(dir, { recursive: true, force: true });
  await client.close();
  await mongod.stop();
});

const sync = (body) => request(app).post('/api/characters/game-sync').set(bearer({ discord_id: 'admin', is_admin: true })).send(body);

describe('POST /api/characters/game-sync', () => {
  it('is reserved to admins', async () => {
    expect((await request(app).post('/api/characters/game-sync')).status).toBe(401);
    expect((await request(app).post('/api/characters/game-sync').set(bearer({ discord_id: 'chef', is_admin: false }))).status).toBe(403);
  });

  it('only simulates by default', async () => {
    const res = await sync({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dryRun: true, languages: ['fr'], statistics: { linked: 1, firstLinks: 1, created: 1 } });
    expect(await db.collection('characters').countDocuments()).toBe(1);
  });

  it('updates the site character in place, keeps hand-entered fields, and creates the new one', async () => {
    const res = await sync({ dryRun: false });
    expect(res.body.statistics).toMatchObject({ updated: 1, created: 1 });

    const linked = await db.collection('characters').findOne({ _id: siteId });
    expect(linked).toMatchObject({ game_id: 61001, search_name: 'Ichigo Bankai', version_name: 'Bankai', release_date: '30/12/2024', killers: ['Hollow'] });
    const created = await db.collection('characters').findOne({ game_id: 65115 });
    expect(created).toMatchObject({ name: 'Ichigo Refine', affinity: 'Vitesse', release_date: '01/01/2025', images_pending: ['thumbnail', 'artwork'] });
  });

  it('changes nothing when run again', async () => {
    const res = await sync({ dryRun: false });
    expect(res.body.statistics).toMatchObject({ linked: 2, firstLinks: 0, updated: 0, created: 0 });
    expect(await db.collection('characters').countDocuments()).toBe(2);
  });
});
