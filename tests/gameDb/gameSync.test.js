import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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
  m_character: [
    { ...unit('61001', '0001', 'ICG', '3'), m_passive_ability_group_id: 'p1' },
    unit('65115', '2000', 'ICG2', '4'),
    { ...unit('81001', '0001', 'ICG', '3'), is_resurrect: '1' },
  ],
  m_dictionary: [
    { dictkey: 'lb_ICG', content_fr: 'Ichigo Kurosaki' },
    { dictkey: 'lb_ICG2', content_fr: 'Ichigo Refine' },
    { dictkey: 'lb_shunpo_up_num', content_fr: 'Rapidité' },
    { dictkey: 'ui_sort_filter_shunpo_up_num', content_fr: 'Rapidité' },
    { dictkey: 'lb_cat_skills', content_fr: 'Capacités augmentées' },
  ],
  m_resource_3d: [{ id: 'mdl', belong_type_1: 'soul_reaper' }],
  m_passive_ability: [{ group_id: 'p1', type: 'shunpo_up_num', view_parameter: '1.0', format: 'plus', description: 'lb_shunpo_up_num' }],
  m_character_resurrect_map: [{ before_m_character_id: '61001', after_m_character_id: '81001' }],
  m_character_filter_category: [{ id: '2', description: 'lb_cat_skills', priority: '900' }],
  m_character_filter: [
    { description: 'heal', usage_type: 'ui_sort_filter_sp_attack_category_type', sort_order: '2' },
    { description: 'barrier', usage_type: 'ui_sort_filter_sp_attack_category_type', sort_order: '1' },
  ],
  m_character_filter_type: [
    { type: 'shunpo_up_num', m_character_filter_category_id: '2', priority: '10' },
    { type: 'heal_up_rate', m_character_filter_category_id: '2', priority: '5' },
  ],
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
  // One folder per client language: the French dump gives the data, the English one its texts
  mkdirSync(join(dir, 'fr'));
  mkdirSync(join(dir, 'en'));
  for (const name of GAME_TABLES) writeFileSync(join(dir, 'fr', `${name}.csv`), csv(TABLES[name] ?? [{ id: '' }]));
  writeFileSync(join(dir, 'en', 'm_dictionary.csv'), csv([{ dictkey: 'lb_ICG', content_en: 'Ichigo Kurosaki EN' }]));
  // Made on the side from the model bundles: at the root, out of reach of a new dump in fr/
  writeFileSync(join(dir, 'attack_hits.csv'), csv([{ resource_3d_id: '0001_ICG_mdl', clip: 'Sp1', variation_index: '0', hits: '3' }]));
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
    expect(res.body).toMatchObject({ dryRun: true, languages: ['fr', 'en'], statistics: { linked: 1, firstLinks: 1, created: 1, attackHitModels: 1 } });
    expect(await db.collection('characters').countDocuments()).toBe(1);
  });

  it('updates the site character in place, keeps hand-entered fields, and creates the new one', async () => {
    const res = await sync({ dryRun: false });
    expect(res.body.statistics).toMatchObject({ updated: 1, created: 1 });

    const linked = await db.collection('characters').findOne({ _id: siteId });
    expect(linked.names).toEqual({ fr: 'Ichigo Kurosaki', en: 'Ichigo Kurosaki EN' });
    expect(linked).toMatchObject({ game_id: 61001, search_name: 'Ichigo Bankai', version_name: 'Bankai', release_date: '30/12/2024', killers: ['Hollow'] });
    const created = await db.collection('characters').findOne({ game_id: 65115 });
    expect(created).toMatchObject({ name: 'Ichigo Refine', affinity: 'Vitesse', release_date: '01/01/2025', images_pending: ['thumbnail', 'artwork', 'quote'] });
  });

  it('filters the list by game ability and resurrection, and lists the game filter in /meta', async () => {
    const names = async (query) => (await request(app).get(`/api/characters?${query}`)).body.data.map((c) => c.game_id);
    expect(await names('traits=shunpo_up_num')).toEqual([61001]);
    expect(await names('traits=shunpo_up_num,heal_up_rate')).toEqual([]);
    expect(await names('resurrection=1')).toEqual([61001]);
    expect(await names('resurrection=0')).toEqual([65115]);

    const meta = await request(app).get('/api/characters/meta');
    // Only the abilities some character has are offered
    // Each group of the game filter only lists what its characters have
    expect(meta.body.filter_groups).toMatchObject({ link: [], ex: [], special: [], destruction: [] });
    expect(meta.body.filter_groups.skill.map((c) => c.types.map((t) => t.type))).toEqual([['shunpo_up_num']]);
    expect(await names('skills=shunpo_up_num')).toEqual([61001]);
    expect(await names('soul_traits=shunpo_up_num')).toEqual([]);
    // Perfect match needs every entry, partial match one of them
    expect(await names('skills=shunpo_up_num,heal_up_rate')).toEqual([]);
    expect(await names('skills=shunpo_up_num,heal_up_rate&skills_match=any')).toEqual([61001]);
    // Several affinities, categories or killers: one of them is enough
    expect((await names('affinity=Force,Vitesse')).sort()).toEqual([61001, 65115]);
    expect(await names('affinity=Force,Technique')).toEqual([61001]);
    expect((await names('killer=Hollow,Quincy')).sort()).toEqual([61001, 65115]);
    expect((await names('category=Shinigami')).sort()).toEqual([61001, 65115]);
    expect(meta.body.trait_filters).toEqual([
      { id: 2, label: { fr: 'Capacités augmentées' }, priority: 900, types: [{ type: 'shunpo_up_num', label: { fr: 'Rapidité' } }] },
    ]);
  });

  it('changes nothing when run again', async () => {
    const res = await sync({ dryRun: false });
    expect(res.body.statistics).toMatchObject({ linked: 2, firstLinks: 0, updated: 0, created: 0 });
    expect(await db.collection('characters').countDocuments()).toBe(2);
  });
});
