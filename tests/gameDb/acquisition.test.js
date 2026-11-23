import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import charactersRouter from '../../src/routes/characters.js';
import { acquisitionUpdates, buildExchanges, computeAcquisitions, legacyOverride } from '../../src/services/gameDb/acquisition.js';

const dict = { text: (key) => ({ fr: `texte ${key}` }) };

const tables = {
  m_exchange_shop: [
    { id: '10', name: 'lb_exchange_tower_medal_shop_name' },
    { id: '3', name: 'lb_exchange_rare_medal_shop_name' },
    { id: '21', name: 'lb_exchange_gacha_medal_shop_name' },
  ],
  m_exchange_shop_category: [
    { id: 'c1', exchange_shop_id: '10', name: 'senkai', end_date: '' },
    { id: 'c2', exchange_shop_id: '3', name: 'bb', end_date: '' },
    { id: 'c3', exchange_shop_id: '21', name: 'medailles_tybw', end_date: '' },
    { id: 'c4', exchange_shop_id: '21', name: 'pity', end_date: '2026-10-01 00:00:00' },
  ],
  m_exchange_shop_product: [
    { exchange_shop_category_id: 'c1', content_type: 'character', content_id: '1001' },
    { exchange_shop_category_id: 'c2', content_type: 'character', content_id: '61002' },
    { exchange_shop_category_id: 'c3', content_type: 'character', content_id: '1003' },
    { exchange_shop_category_id: 'c3', content_type: 'character', content_id: '1004' },
    { exchange_shop_category_id: 'c4', content_type: 'character', content_id: '1005' },
    { exchange_shop_category_id: 'c1', content_type: 'item', content_id: '1006' },
  ],
};

const banner = (name, ids, start = '01/01/2025') => ({ name, start_date: start, character_game_ids: ids });

describe('character acquisition', () => {
  const exchanges = buildExchanges(tables, dict);

  it('reads the shops that give a category and the summon medal exchanges without an end date', () => {
    expect([...exchanges.shop]).toEqual([[1001, 'senkaimon'], [1002, 'brave_battle']]);
    expect([...exchanges.medal.keys()]).toEqual([1003, 1004]);
  });

  it('sorts the units: Brave Souls tickets, seasonal versions, shops, Stern Ritter and exchanges', () => {
    const characters = [
      { game_id: 61001, game_version: { fr: 'version A' } },
      { game_id: 61002, game_version: { fr: 'version B' } },
      { game_id: 61010, game_version: { fr: 'version Fierce' } },
      { game_id: 61011, game_version: { fr: 'version Halloween' } },
      { game_id: 61012, game_version: { fr: 'version pâtissier' }, release_date: '14/02/2025' },
      { game_id: 61013, game_version: { fr: 'version C' }, categories: ['Quincy', 'Stern Ritter'] },
      { game_id: 61003, game_version: { fr: 'version Another Attribute' } },
      { game_id: 61004, game_version: { fr: 'version D' } },
      { game_id: 61014, game_version: { fr: 'version Halloween' } },
      { game_id: 61015, game_version: { fr: 'version E' } },
      { game_id: 69001, game_version: { fr: 'version déchaînée' }, is_growth_event: true },
    ];
    const banners = [
      banner('Ticket de loterie 5★ à choix Brave Souls juin 2026 or', [61010, 61011, 61012, 61013]),
      banner('Ticket de loterie 5★ à choix spécial Brave Souls Fest or', [61015]),
      banner('Loterie primeur Saint-Valentin, pâtisserie', [61012], '14/02/2025'),
      banner('Ticket de loterie 5★ à choix Nouvel An 2020 saisonnier', [61014]),
      banner('Loterie Brave', [61004]),
    ];
    const result = computeAcquisitions(characters, exchanges, banners);
    expect(Object.fromEntries([...result].map(([id, value]) => [id, value.acquisition]))).toEqual({
      61001: 'senkaimon',
      61002: 'brave_battle',
      61010: 'premium',
      61011: 'seasonal',
      61012: 'seasonal',
      61013: 'exclusive',
      61003: 'exchange',
      61004: 'exclusive',
      61014: 'seasonal_medal',
      61015: 'exclusive',
      69001: 'frenzy',
    });
    expect(result.get(61003).acquisition_exchange).toEqual({ fr: 'texte medailles_tybw' });
    expect(result.get(61010).acquisition_exchange).toBeNull();
  });

  it('keeps an old hand-entered value only when the computing disagrees, and only the first time', () => {
    expect(legacyOverride({ rarity: 'Premium' }, 'premium')).toBeNull();
    expect(legacyOverride({ rarity: 'Premium' }, 'exclusive')).toBe('premium');
    expect(legacyOverride({ rarity: 'Divers' }, 'exclusive')).toBe('misc');
    expect(legacyOverride({ rarity: 'Echange La Guerre sanglante de mille ans' }, 'exchange')).toBeNull();
    expect(legacyOverride({}, 'premium')).toBeNull();

    const computed = new Map([[61001, { acquisition: 'exclusive', acquisition_exchange: null }]]);
    expect(acquisitionUpdates([{ _id: 'a', game_id: 61001, rarity: 'Saisonnier' }], computed))
      .toEqual([{ _id: 'a', set: { acquisition: 'exclusive', acquisition_override: 'seasonal' } }]);
    expect(acquisitionUpdates([{ _id: 'a', game_id: 61001, rarity: 'Saisonnier', acquisition: 'exclusive', acquisition_exchange: null, acquisition_override: null }], computed))
      .toEqual([]);
  });
});

describe('PUT /api/characters/:id/acquisition', () => {
  let mongod;
  let client;
  let db;
  let app;
  const admin = () => ({ Authorization: `Bearer ${jwt.sign({ id: 'admin-1', is_admin: true }, process.env.JWT_SECRET)}` });

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    mongod = await MongoMemoryServer.create();
    client = new MongoClient(mongod.getUri());
    await client.connect();
    db = client.db('schrift-test');
    app = express();
    app.use(express.json());
    app.locals.db = db;
    app.use('/api/characters', charactersRouter);
  });

  afterAll(async () => {
    await client.close();
    await mongod.stop();
  });

  it('lets an admin force a category, or go back to the computed one', async () => {
    const _id = new ObjectId();
    await db.collection('characters').insertOne({ _id, name: 'Gremmy', acquisition: 'exclusive' });

    expect((await request(app).put(`/api/characters/${_id}/acquisition`).send({ acquisition: 'premium' })).status).toBe(401);
    expect((await request(app).put(`/api/characters/${_id}/acquisition`).set(admin()).send({ acquisition: 'gold' })).status).toBe(400);

    const res = await request(app).put(`/api/characters/${_id}/acquisition`).set(admin()).send({ acquisition: 'premium' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ acquisition: 'exclusive', acquisition_override: 'premium' });

    await request(app).put(`/api/characters/${_id}/acquisition`).set(admin()).send({ acquisition: null });
    expect((await db.collection('characters').findOne({ _id })).acquisition_override).toBeNull();
  });
});
