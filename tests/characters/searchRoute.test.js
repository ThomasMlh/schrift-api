import express from 'express';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import charactersRouter from '../../src/routes/characters.js';
import { accentInsensitive } from '../../src/utils/search.js';
import { acquisitionsMatching } from '../../src/services/gameDb/acquisition.js';

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
  app.use('/api/characters', charactersRouter);
  await db.collection('characters').insertMany([
    { name: 'Rin', sort_order: 1, acquisition: 'seasonal', acquisition_override: null },
    { name: 'Yoruichi', sort_order: 2, acquisition: 'exclusive', acquisition_override: 'seasonal' },
    { name: 'Izuru', sort_order: 3, acquisition: 'premium' },
    { name: 'Gremmy', sort_order: 4, acquisition: 'seasonal', acquisition_override: 'premium' },
    { name: 'Ichigo', sort_order: 5, acquisition: 'exclusive', banners: [{ gacha_group_id: 7 }, { gacha_group_id: 8 }] },
  ]);
  await db.collection('banners').insertMany([{ gacha_group_id: 7, name: 'Loterie Brave Souls saisonnière gratuite' }, { gacha_group_id: 8, name: 'Loterie été brûlant' }]);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

const names = async (search) => (await request(app).get('/api/characters').query({ search })).body.data.map((c) => c.name);

describe('character search', () => {
  it('ignores accents and reads the category names', () => {
    expect(new RegExp(accentInsensitive('Saisonnie'), 'i').test('saisonnière')).toBe(true);
    expect(accentInsensitive('a.*(b')).toBe('[aàâä]b');
    expect(acquisitionsMatching('saisonnier')).toEqual(['seasonal', 'seasonal_medal']);
    expect(acquisitionsMatching('exclusive')).toEqual(['exclusive']);
    expect(acquisitionsMatching('ab')).toEqual([]);
  });

  it('finds the characters of a category (admin choice first) without the summons, and summons whatever the accents', async () => {
    expect(await names('Saisonnier')).toEqual(['Rin', 'Yoruichi']);
    expect(await names('Saisonnie')).toEqual(['Rin', 'Yoruichi']);
    expect(await names('ete brulant')).toEqual(['Ichigo']);
    expect(await names('premium')).toEqual(['Izuru', 'Gremmy']);
  });
});
