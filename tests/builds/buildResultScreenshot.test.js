import express from 'express';
import request from 'supertest';
import sharp from 'sharp';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import buildsRouter from '../../src/routes/builds/index.js';
import { parseBuildResult } from '../../src/routes/builds/result.js';
import { screenshotFilename, decodeImage, setScreenshotStorage } from '../../src/services/buildScreenshots.js';

jest.setTimeout(60000);

let mongod;
let client;
let db;
let app;
// Stockage FTP remplacé par une mémoire : nom de fichier → taille
const stored = new Map();

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');

  setScreenshotStorage({
    upload: async (buffer, filename) => { stored.set(filename, buffer.length); },
    remove: async (filename) => { stored.delete(filename); },
  });

  app = express();
  app.use(express.json({ limit: '20mb' }));
  app.locals.db = db;
  app.use('/api/builds', buildsRouter);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  stored.clear();
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

const tokenFor = (payload) => ({ Authorization: `Bearer ${jwt.sign(payload, process.env.JWT_SECRET)}` });

const pngDataUrl = async () => {
  const buffer = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#7c3aed' } }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString('base64')}`;
};

describe('parseBuildResult', () => {
  it('keeps only the provided fields and normalises them', () => {
    expect(parseBuildResult({ score: '612480300', time_normal_wave: '56.5984' })).toEqual({
      values: { score: 612480300, time_normal_wave: 56.598 },
      error: null,
    });
    expect(parseBuildResult({})).toEqual({ values: {}, error: null });
  });

  it('turns empty values into null to clear a field', () => {
    expect(parseBuildResult({ score: '', time_extra_wave: null }).values).toEqual({ score: null, time_extra_wave: null });
  });

  it('rejects an implausible score or chrono', () => {
    expect(parseBuildResult({ score: 700_000_000 }).error).toMatch(/score/);
    expect(parseBuildResult({ score: 1.5 }).error).toMatch(/score/);
    expect(parseBuildResult({ time_normal_wave: -3 }).error).toMatch(/time_normal_wave/);
    expect(parseBuildResult({ time_extra_wave: 'abc' }).error).toMatch(/time_extra_wave/);
  });
});

describe('screenshot helpers', () => {
  it('names a screenshot after the build and the UTC time', () => {
    expect(screenshotFilename('abc123', new Date(Date.UTC(2026, 9, 10, 15, 30, 12)))).toBe('abc123_20261010-153012.webp');
  });

  it('decodes data URLs and rejects invalid content', () => {
    expect(decodeImage('data:image/png;base64,aGVsbG8=')?.toString()).toBe('hello');
    expect(decodeImage('not base64 !')).toBeNull();
    expect(decodeImage(undefined)).toBeNull();
  });
});

describe('build result fields', () => {
  it('stores score and chronos on creation', async () => {
    const { insertedId: rotationId } = await db.collection('rotations').insertOne({ killer: 'X', attack: 'R' });
    const { insertedId: characterId } = await db.collection('characters').insertOne({ name: 'Ichigo' });

    const res = await request(app).post('/api/builds').send({
      rotation_id: rotationId.toString(),
      team: [{ id_character: characterId.toString(), position: 1 }],
      score: 612480300,
      time_normal_wave: 56.598,
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ score: 612480300, time_normal_wave: 56.598, time_extra_wave: null, screenshot: null });
  });

  it('rejects an invalid score on creation', async () => {
    const res = await request(app).post('/api/builds').send({ rotation_id: 'x', team: [], score: -1 });
    expect(res.status).toBe(400);
  });

  it('only saves editable fields on update', async () => {
    const { insertedId: userId } = await db.collection('users').insertOne({ username: 'owner' });
    const { insertedId: buildId } = await db.collection('builds').insertOne({
      rotation_id: 'r1', team: [], user_id: userId.toString(), isValid: true, screenshot: 'keep.webp',
    });

    const res = await request(app)
      .patch(`/api/builds/${buildId}`)
      .set(tokenFor({ userId: userId.toString() }))
      .send({ description: 'Nouvelle note', score: 600000000, user_id: 'someone-else', screenshot: 'hack.webp' });

    expect(res.status).toBe(200);
    const saved = await db.collection('builds').findOne({ _id: buildId });
    expect(saved).toMatchObject({ description: 'Nouvelle note', score: 600000000, user_id: userId.toString(), screenshot: 'keep.webp', isValid: false });
  });
});

describe('POST/DELETE /api/builds/:id/screenshot', () => {
  const createOwnedBuild = async (extra = {}) => {
    const { insertedId: userId } = await db.collection('users').insertOne({ username: 'owner' });
    const { insertedId: buildId } = await db.collection('builds').insertOne({
      rotation_id: 'r1', team: [], user_id: userId.toString(), isValid: false, ...extra,
    });
    return { userId: userId.toString(), buildId };
  };

  it('requires authentication', async () => {
    const { buildId } = await createOwnedBuild();
    const res = await request(app).post(`/api/builds/${buildId}/screenshot`).send({ image: await pngDataUrl() });
    expect(res.status).toBe(401);
  });

  it('refuses a user who is neither the author nor an admin', async () => {
    const { buildId } = await createOwnedBuild();
    const res = await request(app)
      .post(`/api/builds/${buildId}/screenshot`)
      .set(tokenFor({ userId: new ObjectId().toString() }))
      .send({ image: await pngDataUrl() });
    expect(res.status).toBe(403);
  });

  it('rejects content that is not an image', async () => {
    const { userId, buildId } = await createOwnedBuild();
    const res = await request(app)
      .post(`/api/builds/${buildId}/screenshot`)
      .set(tokenFor({ userId }))
      .send({ image: 'data:image/png;base64,aGVsbG8=' });
    expect(res.status).toBe(400);
  });

  it('converts, uploads and replaces the previous screenshot', async () => {
    const { userId, buildId } = await createOwnedBuild({ screenshot: 'old.webp' });
    stored.set('old.webp', 1);

    const res = await request(app)
      .post(`/api/builds/${buildId}/screenshot`)
      .set(tokenFor({ userId }))
      .send({ image: await pngDataUrl() });

    expect(res.status).toBe(200);
    expect(res.body.screenshot).toMatch(new RegExp(`^${buildId}_\\d{8}-\\d{6}\\.webp$`));
    expect(stored.has(res.body.screenshot)).toBe(true);
    expect(stored.has('old.webp')).toBe(false);
    expect((await db.collection('builds').findOne({ _id: buildId })).screenshot).toBe(res.body.screenshot);
  });

  it('removes the screenshot', async () => {
    const { userId, buildId } = await createOwnedBuild({ screenshot: 'shot.webp' });
    stored.set('shot.webp', 1);

    const res = await request(app).delete(`/api/builds/${buildId}/screenshot`).set(tokenFor({ userId }));

    expect(res.status).toBe(200);
    expect(stored.has('shot.webp')).toBe(false);
    expect((await db.collection('builds').findOne({ _id: buildId })).screenshot).toBeNull();
  });

  it('lets an admin replace the screenshot of any build', async () => {
    const { buildId } = await createOwnedBuild();
    const res = await request(app)
      .post(`/api/builds/${buildId}/screenshot`)
      .set(tokenFor({ id: 'admin-1', is_admin: true }))
      .send({ image: await pngDataUrl() });
    expect(res.status).toBe(200);
  });
});
