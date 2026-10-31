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
  app.use((req, _res, next) => { req.db = db; next(); });
  app.use('/api/characters', charactersRouter);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

describe('GET /api/characters/:id summon history', () => {
  it('lists the character summons of a unit, from the game tables and the rate pages', async () => {
    const { insertedId } = await db.collection('characters').insertOne({ name: 'Rukia', game_id: 61309 });
    const summon = (id, fields) => ({ gacha_group_id: id, list_category: 'character_gacha', name: `Loterie ${id}`, names: { fr: `Loterie ${id}`, en: `Summon ${id}` }, start_date: '01/01/2025', end_date: '02/01/2025', ...fields });
    await db.collection('banners').insertMany([
      summon(1, { character_game_ids: [61309] }),
      summon(2, { character_game_ids: [], rates: { sections: [{ kind: 'selection', units: [{ name: 'Rukia', game_id: 61309 }] }] } }),
      summon(3, { character_game_ids: [1] }),
      summon(4, { list_category: 'character_ticket', character_game_ids: [61309] }),
    ]);

    const { body } = await request(app).get(`/api/characters/${insertedId}`).expect(200);

    expect(body.data.summon_history.map((s) => s.gacha_group_id).sort()).toEqual([1, 2]);
    expect(body.data.summon_history[0]).toMatchObject({ name: { fr: 'Loterie 1', en: 'Summon 1' }, start_date: '01/01/2025' });
  });

  it('gives no history to a character without a game id', async () => {
    const { insertedId } = await db.collection('characters').insertOne({ name: 'Ancien' });
    const { body } = await request(app).get(`/api/characters/${insertedId}`).expect(200);
    expect(body.data).not.toHaveProperty('summon_history');
  });
});
