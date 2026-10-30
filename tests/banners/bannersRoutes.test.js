import express from 'express';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import bannersRouter from '../../src/routes/banners.js';

jest.setTimeout(60000);

let mongod;
let client;
let db;
let app;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');
  app = express();
  app.locals.db = db;
  app.use('/api/banners', bannersRouter);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

describe('GET /api/banners/game', () => {
  const summon = (id, category, startedAt, fields = {}) => ({
    gacha_group_id: id, name: `Loterie ${id}`, list_category: category, summon_type: 'standard',
    started_at: new Date(startedAt), ended_at: new Date('2020-01-01T00:00:00Z'), ...fields,
  });

  beforeAll(async () => {
    await db.collection('banners').insertMany([
      summon(9001, 'character_gacha', '2024-05-01T00:00:00Z', { names: { fr: 'Guerre sanglante (x10)', en: 'Blood War' }, summon_type: 'step_up' }),
      summon(9002, 'character_gacha', '2025-05-01T00:00:00Z', { ended_at: new Date(Date.now() + 86400000), started_at: new Date(Date.now() - 86400000) }),
      summon(9003, 'character_gacha', '2023-05-01T00:00:00Z'),
      summon(9005, 'accessory_gacha', '2022-05-01T00:00:00Z', { ended_at: null }),
      summon(9004, 'character_ticket', '2025-05-01T00:00:00Z'),
      { gacha_group_id: 0, name: 'Anciennes invocations' },
    ]);
  });

  afterAll(() => db.collection('banners').deleteMany({}));

  const ids = (res) => res.body.data.map((s) => s.gacha_group_id);

  it('lists a category newest first, with the tab counts and its years', async () => {
    const res = await request(app).get('/api/banners/game?category=character_gacha');
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([9002, 9001, 9003]);
    expect(res.body.total).toBe(3);
    expect(res.body.counts).toEqual({ character_gacha: 3, character_ticket: 1, accessory_gacha: 1 });
    expect(res.body.years).toContain(2024);
    expect(res.body.data[0].details).toBeUndefined();
  });

  it('searches the names literally in every language', async () => {
    const french = await request(app).get('/api/banners/game').query({ search: 'sanglante (x' });
    expect(ids(french)).toEqual([9001]);
    const english = await request(app).get('/api/banners/game').query({ search: 'blood' });
    expect(ids(english)).toEqual([9001]);
  });

  it('filters by kind, year and ongoing summons', async () => {
    expect(ids(await request(app).get('/api/banners/game?type=step_up'))).toEqual([9001]);
    expect(ids(await request(app).get('/api/banners/game?year=2023'))).toEqual([9003]);
    expect(ids(await request(app).get('/api/banners/game?ongoing=true'))).toEqual([9002]);
    expect(ids(await request(app).get('/api/banners/game?category=accessory_gacha&ongoing=true'))).toEqual([9005]);
  });

  it('paginates and rejects an unknown category', async () => {
    const res = await request(app).get('/api/banners/game?limit=1&page=2');
    expect(ids(res)).toEqual([9001]);
    expect(res.body.total).toBe(3);
    expect((await request(app).get('/api/banners/game?category=other')).status).toBe(400);
  });
});

describe('GET /api/banners/game/:gachaGroupId', () => {
  it('does not read the featured accessories of a summon as characters', async () => {
    await db.collection('banners').insertOne({
      gacha_group_id: 2010, list_category: 'accessory_gacha', character_game_ids: [], details: { featured: [{ game_id: 61000, badge: null }] },
    });
    await db.collection('characters').insertOne({ name: 'Renji', game_id: 61000 });
    const res = await request(app).get('/api/banners/game/2010');
    expect(res.body.data.characters).toEqual([]);
    await db.collection('banners').deleteOne({ gacha_group_id: 2010 });
    await db.collection('characters').deleteMany({});
  });

  it('returns the summon with the site characters it features', async () => {
    await db.collection('banners').insertOne({
      gacha_group_id: 867,
      name: 'Refine 2',
      character_game_ids: [65122],
      details: { featured: [{ game_id: 65122, badge: null }, { game_id: 65000, badge: null }] },
    });
    await db.collection('characters').insertMany([
      { name: 'Ichigo', game_id: 65122, affinity: 'Force', skills: ['not sent'] },
      { name: 'Rukia', game_id: 65000 },
      { name: 'Renji', game_id: 61000 },
    ]);

    const res = await request(app).get('/api/banners/game/867');
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Refine 2');
    expect(res.body.data.characters.map((c) => c.name).sort()).toEqual(['Ichigo', 'Rukia']);
    expect(res.body.data.characters.find((c) => c.name === 'Ichigo').skills).toBeUndefined();
  });

  it('answers 400 for an invalid id and 404 for an unknown summon', async () => {
    expect((await request(app).get('/api/banners/game/abc')).status).toBe(400);
    expect((await request(app).get('/api/banners/game/1')).status).toBe(404);
  });
});
