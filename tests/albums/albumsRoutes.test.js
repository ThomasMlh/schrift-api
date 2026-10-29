import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import albumsRouter from '../../src/routes/albums.js';

jest.setTimeout(60000);

let mongod;
let client;
let db;
let app;

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');

  app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/api/albums', albumsRouter);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

const tokenFor = (payload) => ({ Authorization: `Bearer ${jwt.sign(payload, process.env.JWT_SECRET)}` });

const seed = async () => {
  const ownerId = new ObjectId();
  const otherId = new ObjectId();
  const characterId = new ObjectId();
  await db.collection('users').insertMany([
    { _id: ownerId, bbs_accounts: [{ bbs_id: 'main1', is_primary: true }, { bbs_id: 'alt1' }] },
    { _id: otherId, bbs_accounts: [{ bbs_id: 'other1', is_primary: true }] },
  ]);
  await db.collection('characters').insertOne({ _id: characterId, name: 'Rangiku' });
  return { ownerId: ownerId.toString(), otherId: otherId.toString(), characterId: characterId.toString() };
};

describe('GET /api/albums/guild/:guildeId', () => {
  it('requires a token', async () => {
    const res = await request(app).get('/api/albums/guild/g1');
    expect(res.status).toBe(401);
  });

  it('returns every guild account with its album, null when never filled', async () => {
    const characterId = new ObjectId().toString();
    await db.collection('users').insertMany([
      { _id: new ObjectId(), bbs_accounts: [
        { bbs_id: 'main1', bbs_name: 'Main', guilde_id: 'g1', is_primary: true },
        { bbs_id: 'alt1', bbs_name: 'Alt', guilde_id: 'g2' },
      ] },
      { _id: new ObjectId(), bbs_accounts: [{ bbs_id: 'other1', bbs_name: 'Other', guilde_id: 'g1', is_primary: true }] },
    ]);
    await db.collection('albums').insertMany([
      { bbs_id: 'main1', characters: { [characterId]: 3 } },
      { bbs_id: 'alt1', characters: { [characterId]: 5 } },
    ]);

    const res = await request(app).get('/api/albums/guild/g1').set(tokenFor({ is_admin: true }));
    expect(res.status).toBe(200);
    const byBbsId = Object.fromEntries(res.body.data.map((m) => [m.bbs_id, m.characters]));
    expect(byBbsId).toEqual({ main1: { [characterId]: 3 }, other1: null });
  });
});

describe('GET /api/albums/:bbsId', () => {
  it('returns an empty album for an account that never filled it', async () => {
    const res = await request(app).get('/api/albums/main1');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ bbs_id: 'main1', characters: {}, updated_at: null });
  });
});

describe('PUT /api/albums/:bbsId', () => {
  it('saves every change of a session at once, on an alt too', async () => {
    const { ownerId, characterId } = await seed();
    const other = (await db.collection('characters').insertOne({ name: 'Gin', version: 'Bankai' })).insertedId.toString();
    const put = (changes) => request(app).put('/api/albums/alt1').set(tokenFor({ _id: ownerId })).send({ changes });

    let res = await put({ [characterId]: 1, [other]: 4 });
    expect(res.status).toBe(200);
    expect(res.body.data.characters).toEqual({ [characterId]: 1, [other]: 4 });

    res = await put({ [characterId]: 5, [other]: 0 });
    expect(res.body.data.characters).toEqual({ [characterId]: 5 });

    const pub = await request(app).get('/api/albums/alt1');
    expect(pub.body.data.characters).toEqual({ [characterId]: 5 });
    expect(await db.collection('albums').countDocuments()).toBe(1);
  });

  it('logs one activity entry per save with what changed, none when nothing did', async () => {
    const guildeId = new ObjectId();
    const userId = new ObjectId();
    const { insertedIds } = await db.collection('characters').insertMany([
      { name: 'Rangiku', version: 'Bankai' }, { name: 'Gin' }, { name: 'Toshiro' },
    ]);
    const [a, b, c] = Object.values(insertedIds).map(String);
    await db.collection('users').insertOne({ _id: userId, bbs_name: 'Owner', bbs_accounts: [{ bbs_id: 'main1', bbs_name: 'Main', guilde_id: guildeId, is_primary: true }] });
    await db.collection('guildes').insertOne({ _id: guildeId, name: 'Schrift' });
    await db.collection('albums').insertOne({ bbs_id: 'main1', characters: { [b]: 2, [c]: 3 } });
    const put = (changes) => request(app).put('/api/albums/main1').set(tokenFor({ _id: userId.toString() })).send({ changes });

    expect((await put({ [a]: 1, [b]: 0, [c]: 5 })).status).toBe(200);
    await put({ [a]: 1 });
    await put({});

    const log = await db.collection('activity_log').find().toArray();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      type: 'album_update',
      guilde_id: guildeId.toString(),
      data: {
        edited_by: 'Owner',
        bbs_id: 'main1',
        bbs_name: 'Main',
        guild_name: 'Schrift',
        added: [{ name: 'Rangiku', version: 'Bankai', spe: 1 }],
        removed: [{ name: 'Gin', version: '', spe: 2 }],
        changed: [{ name: 'Toshiro', version: '', from: 3, to: 5 }],
      },
    });
  });

  it('requires a token', async () => {
    const { characterId } = await seed();
    const res = await request(app).put('/api/albums/main1').send({ changes: { [characterId]: 1 } });
    expect(res.status).toBe(401);
  });

  it("refuses to edit another player's album, but allows admins", async () => {
    const { otherId, characterId } = await seed();
    const put = (payload) => request(app).put('/api/albums/main1').set(tokenFor(payload)).send({ changes: { [characterId]: 2 } });

    expect((await put({ _id: otherId })).status).toBe(403);

    const admin = await put({ _id: otherId, is_admin: true });
    expect(admin.status).toBe(200);
    expect(admin.body.data.characters).toEqual({ [characterId]: 2 });
  });

  it('lets a guild leader or officer edit the albums of their guild only when admins allow it', async () => {
    const guildA = new ObjectId();
    const guildB = new ObjectId();
    const chefId = new ObjectId();
    const memberId = new ObjectId();
    const characterId = new ObjectId();
    await db.collection('users').insertMany([
      // Leads guild A on an alt, plain member of guild B on the main account
      { _id: chefId, bbs_accounts: [{ bbs_id: 'chefmain', guilde_id: guildB, role: 'membre' }, { bbs_id: 'chefalt', guilde_id: guildA, role: 'sous-chef' }] },
      { _id: memberId, bbs_accounts: [{ bbs_id: 'inA', guilde_id: guildA, role: 'membre' }, { bbs_id: 'inB', guilde_id: guildB, role: 'membre' }] },
    ]);
    await db.collection('characters').insertOne({ _id: characterId, name: 'Rangiku' });
    // The token says nothing about roles: they are read from the database
    const chef = tokenFor({ _id: chefId.toString() });
    const put = (bbsId) => request(app).put(`/api/albums/${bbsId}`).set(chef).send({ changes: { [characterId]: 3 } });

    expect((await put('inA')).status).toBe(403);

    await db.collection('app_settings').insertOne({ _id: 'albums', leaders_can_edit: true });
    const allowed = await put('inA');
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.characters).toEqual({ [characterId.toString()]: 3 });
    // Same player, account in a guild they do not lead
    expect((await put('inB')).status).toBe(403);
  });

  it('rejects invalid changes, an unknown account or an unknown character, and then writes nothing', async () => {
    const { ownerId, characterId } = await seed();
    const auth = tokenFor({ _id: ownerId });
    const put = (bbsId, changes) => request(app).put(`/api/albums/${bbsId}`).set(auth).send({ changes });

    for (const spe of [6, -1, 1.5, 'abc', null]) {
      expect((await put('main1', { [characterId]: spe })).status).toBe(400);
    }
    for (const changes of [undefined, [], 'x']) expect((await put('main1', changes)).status).toBe(400);
    expect((await put('main1', { nope: 1 })).status).toBe(400);
    expect((await put('ghost', { [characterId]: 1 })).status).toBe(404);
    expect((await put('main1', { [characterId]: 1, [new ObjectId()]: 1 })).status).toBe(404);
    expect(await db.collection('albums').countDocuments()).toBe(0);
  });
});
