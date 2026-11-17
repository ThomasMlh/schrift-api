import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import eventsRouter from '../../src/routes/events.js';
import eventsAdminRouter from '../../src/routes/eventsAdmin.js';
import { answerCase, defaultAccepted, getCalendar, reviewCaseAnswer, saveCase } from '../../src/services/advent/index.js';
import { renderClue, setAdventStorage } from '../../src/services/advent/clues.js';
import { createEvent } from '../../src/services/quiz/index.js';
import { listUserBadges } from '../../src/services/eventBadges.js';

jest.setTimeout(60000);
const JWT_SECRET = 'test-secret';
let mongod;
let client;
let db;
let app;
const files = new Map();

// A 40×60 red figure on a transparent 100×100 canvas
const artwork = () => sharp({ create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: { create: { width: 40, height: 60, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }, left: 30, top: 20 }])
  .png().toBuffer();

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');
  app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/api/admin/events', eventsAdminRouter);
  app.use('/api/events', eventsRouter);
  const art = await artwork();
  setAdventStorage({
    artwork: async () => art,
    write: async (path, buffer) => { files.set(path, buffer); },
    remove: async (path) => { files.delete(path); },
  });
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  files.clear();
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

const bearer = (payload) => ({ Authorization: `Bearer ${jwt.sign(payload, JWT_SECRET)}` });
const START = new Date('2026-12-01T00:00:00+01:00');
const END = new Date('2026-12-31T23:59:00+01:00');
const day = (n, hours = 10) => new Date(START.getTime() + (n - 1) * 86400000 + hours * 3600000);

const seed = async ({ badge = 'Anniversaire 2026' } = {}) => {
  const { insertedId: characterId } = await db.collection('characters').insertOne({
    name: 'Renji Abarai', names: { fr: 'Renji Abarai', en: 'Renji Abarai' }, short_names: { fr: 'Renji' },
    source_images: { artwork: 'https://rmfs/fr/Characters/x/stand_gacha.png' },
  });
  const users = await db.collection('users').insertMany([{ discord_id: 'p1', username: 'one' }, { discord_id: 'p2', username: 'two' }]);
  const event = await createEvent(db, {
    name: 'Anniversaire', kind: 'anniversary', start_at: START, end_at: END, badge_name: badge, advent: { enabled: true, days: 24, points: 10 },
  });
  const eventId = event._id.toString();
  await saveCase(db, eventId, 1, { character_id: characterId.toString(), clue_type: 'silhouette' });
  await saveCase(db, eventId, 2, { character_id: characterId.toString(), clue_type: 'zoom', settings: { x: 0.5, y: 0.4, scale: 2 } });
  return { eventId, one: { _id: users.insertedIds[0].toString() }, two: { _id: users.insertedIds[1].toString() } };
};

describe('clues', () => {
  it('paints the silhouette in one colour and keeps only the figure', async () => {
    const out = await renderClue(await artwork(), 'silhouette', {});
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(640);
    expect(data[0]).toBeLessThan(40);
  });

  it('accepts the full and short names and their words', () => {
    expect(defaultAccepted({ name: 'Byakuya Kuchiki', short_names: { fr: 'Byakuya' } })).toEqual(['Byakuya Kuchiki', 'Byakuya', 'Kuchiki']);
  });
});

describe('advent calendar', () => {
  it('shows only the opened cases, without naming the character', async () => {
    const { eventId } = await seed();
    const calendar = await getCalendar(db, eventId, null, day(1));
    expect(calendar.days).toHaveLength(24);
    expect(calendar.days[0]).toMatchObject({ day: 1, state: 'today', clue: { type: 'silhouette' } });
    expect(calendar.days[0].clue.path).toMatch(/^advent\/[a-f0-9]{24}\/[a-f0-9]{24}\.webp$/);
    expect(calendar.days[1].state).toBe('locked');
    // Day 3 has come but nobody filled it
    expect((await getCalendar(db, eventId, null, day(3))).days[2].state).toBe('empty');
    expect(calendar.days[1].clue).toBeUndefined();
    expect(JSON.stringify(calendar)).not.toContain('Renji');
  });

  it('scores an answer on the day, half later, once per case, and gives the badge', async () => {
    const { eventId, one, two } = await seed();
    expect((await answerCase(db, eventId, 1, one, 'renji', day(1))).result).toBe('correct');
    await expect(answerCase(db, eventId, 1, one, 'Renji', day(1))).rejects.toMatchObject({ statusCode: 409 });
    await expect(answerCase(db, eventId, 2, one, 'Renji', day(1))).rejects.toMatchObject({ statusCode: 403 });
    expect(await answerCase(db, eventId, 2, one, 'Renji Abarai', day(4))).toMatchObject({ result: 'correct', late: true, points: 5 });
    expect((await answerCase(db, eventId, 1, two, 'Ichigo', day(1))).result).toBe('wrong');

    const { rankings } = await getCalendar(db, eventId, one, day(4));
    expect(rankings.all.map((r) => [r.name, r.points, r.rank])).toEqual([['one', 15, 1], ['two', 0, 2]]);
    expect((await listUserBadges(db, one._id))[0]).toMatchObject({ name: 'Anniversaire 2026', year: 2026, holders: 2 });
  });

  it('lets an admin accept a close answer', async () => {
    const { eventId, one } = await seed();
    expect((await answerCase(db, eventId, 1, one, 'Renjo Abareio', day(1))).result).toBe('pending');
    const answer = await db.collection('advent_answers').findOne({});
    await reviewCaseAnswer(db, answer._id.toString(), true);
    const calendar = await getCalendar(db, eventId, one, day(1));
    expect(calendar.days[0].mine).toMatchObject({ result: 'correct', points: 10 });
  });

  it('reveals the characters once the event is over, and gives no badge any more', async () => {
    const { eventId, one } = await seed();
    const after = new Date(END.getTime() + 1000);
    expect((await getCalendar(db, eventId, one, after)).days[0].character.name).toBe('Renji Abarai');
    await expect(answerCase(db, eventId, 1, one, 'Renji', after)).rejects.toMatchObject({ statusCode: 403 });
    expect(await listUserBadges(db, one._id)).toEqual([]);
  });

  it('serves the routes', async () => {
    const { eventId } = await seed();
    const player = bearer({ _id: (await db.collection('users').findOne({ discord_id: 'p1' }))._id.toString() });
    expect((await request(app).get(`/api/events/${eventId}/advent`)).status).toBe(200);
    expect((await request(app).post(`/api/events/${eventId}/advent/1/answer`).send({ answer: 'Renji' })).status).toBe(401);
    expect((await request(app).get(`/api/admin/events/${eventId}/advent`).set(player)).status).toBe(403);
    const admin = await request(app).get(`/api/admin/events/${eventId}/advent`).set(bearer({ discord_id: 'a', is_admin: true }));
    expect(admin.body.data.cases).toHaveLength(2);
    expect(admin.body.data.cases[0].character.name).toBe('Renji Abarai');
  });
});
