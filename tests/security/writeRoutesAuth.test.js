import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import charactersRouter from '../../src/routes/characters.js';
import cyclesRouter from '../../src/routes/cycles.js';
import guildesRouter from '../../src/routes/guildes/index.js';
import membresRouter from '../../src/routes/membres.js';
import guidesRouter from '../../src/routes/guides.js';
import buildsRouter from '../../src/routes/builds/index.js';
import usersRouter from '../../src/routes/users/index.js';

// Regression: write routes modifying guilds, cycles, members, guides, builds and users used to be
// reachable without authentication. Each must reject an anonymous request, and a leader may only act
// on their own guild.
jest.setTimeout(60000);

const JWT_SECRET = 'test-secret';

let mongod;
let client;
let db;
let app;

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');

  app = express();
  app.use(express.json());
  app.locals.db = db;
  // Routers mounted one by one (like src/routes/index.js) without the OCR module, which is heavy to load
  app.use('/api/characters', charactersRouter);
  app.use('/api/cycles', cyclesRouter);
  app.use('/api/guildes', guildesRouter);
  app.use('/api/membres', membresRouter);
  app.use('/api/guides', guidesRouter);
  app.use('/api/builds', buildsRouter);
  app.use('/api/users', usersRouter);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

const id = () => new ObjectId().toString();
const memberToken = () => jwt.sign({ _id: id() }, JWT_SECRET);
// The middleware reads leader grants from the database: the chef's user must exist there
const chefToken = async (guildId) => {
  const _id = new ObjectId();
  await db.collection('users').insertOne({ _id, bbs_accounts: [{ guilde_id: guildId, role: 'chef' }] });
  return jwt.sign({ _id: _id.toString() }, JWT_SECRET);
};

const PROTECTED = [
  ['post', '/api/characters/admin/create-indexes'],
  ['post', '/api/cycles'],
  ['put', () => `/api/cycles/${id()}`],
  ['delete', () => `/api/cycles/${id()}`],
  ['post', '/api/guildes'],
  ['put', () => `/api/guildes/${id()}`],
  ['delete', () => `/api/guildes/${id()}`],
  ['post', () => `/api/guildes/${id()}/assign-member`],
  ['delete', () => `/api/guildes/${id()}/members/${id()}`],
  ['delete', () => `/api/guildes/${id()}/membres/${id()}`],
  ['post', () => `/api/guildes/${id()}/membres`],
  ['put', () => `/api/membres/${id()}/role`],
  ['put', () => `/api/membres/${id()}/guilde`],
  ['delete', () => `/api/membres/${id()}`],
  ['post', '/api/guides/orbes'],
  ['patch', () => `/api/guides/orbes/${id()}`],
  ['delete', () => `/api/guides/orbes/${id()}`],
  ['delete', () => `/api/builds/${id()}`],
  ['patch', () => `/api/users/${id()}`],
];

describe('write routes require authentication', () => {
  it.each(PROTECTED)('%s %s rejects an anonymous request', async (method, path) => {
    const url = typeof path === 'function' ? path() : path;
    const res = await request(app)[method](url).send({ name: 'x', is_admin: true });
    expect(res.status).toBe(401);
  });

  it('a plain member cannot promote themselves to admin', async () => {
    const { insertedId } = await db.collection('users').insertOne({ username: 'eve', is_admin: false });
    const res = await request(app).patch(`/api/users/${insertedId}`)
      .set('Authorization', `Bearer ${memberToken()}`).send({ is_admin: true });
    expect(res.status).toBe(403);
    expect((await db.collection('users').findOne({ _id: insertedId })).is_admin).toBe(false);
  });
});

describe('PUT /api/guildes/:id for chefs', () => {
  it('lets a chef update the notifications of their own guild, but not rename it or touch another guild', async () => {
    const { insertedId } = await db.collection('guildes').insertOne({ name: 'Les Quincy' });
    const guildId = insertedId.toString();
    const auth = { Authorization: `Bearer ${await chefToken(guildId)}` };

    const ok = await request(app).put(`/api/guildes/${guildId}`).set(auth)
      .send({ name: 'Les Quincy', discord_channel_id: '123', disabled_notification_types: ['scores'] });
    expect(ok.status).toBe(200);
    expect(await db.collection('guildes').findOne({ _id: insertedId })).toMatchObject({ discord_channel_id: '123', disabled_notification_types: ['scores'] });

    const rename = await request(app).put(`/api/guildes/${guildId}`).set(auth).send({ name: 'Autre nom' });
    expect(rename.status).toBe(403);

    const other = await request(app).put(`/api/guildes/${id()}`).set(auth).send({ name: 'X' });
    expect(other.status).toBe(403);
  });
});
