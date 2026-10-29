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

describe('GET /api/banners/game/:gachaGroupId', () => {
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
