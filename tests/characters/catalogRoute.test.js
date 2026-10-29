import express from 'express';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import charactersRouter from '../../src/routes/characters.js';

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
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

describe('GET /api/characters/catalog', () => {
  it('returns every character, light and sorted, without being caught by /:id', async () => {
    await db.collection('characters').insertMany(
      Array.from({ length: 250 }, (_, i) => ({
        name: `Perso ${i}`, sort_order: 250 - i, affinity: 'Force', killers: ['Capitaine +'], categories: ['Shinigami'], stats: { attack: 1 }, soul_traits: ['x'],
        filters: { link: ['atk_up'], skill: ['heal'] },
      }))
    );

    const res = await request(app).get('/api/characters/catalog');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(250);
    expect(res.body.data[0].name).toBe('Perso 249');
    expect(Object.keys(res.body.data[0]).sort()).toEqual(['_id', 'affinity', 'categories', 'filters', 'killers', 'name']);
    expect(res.body.data[0].filters).toEqual({ link: ['atk_up'], skill: ['heal'] });
  });
});
