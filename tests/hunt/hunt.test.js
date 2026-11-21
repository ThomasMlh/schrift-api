import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import eventsRouter from '../../src/routes/events.js';
import eventsAdminRouter from '../../src/routes/eventsAdmin.js';
import {
  checkPage, claimGift, huntTicketsBetween, huntView, normalizePath, randomSpot, saveSpot,
} from '../../src/services/hunt/index.js';
import { clearLiveCache, getLiveEvent, goalProgress, sanitizeGoal } from '../../src/services/eventGoal.js';
import { getCalendar } from '../../src/services/advent/index.js';
import { createEvent, getEventById } from '../../src/services/quiz/index.js';
import { listUserBadges } from '../../src/services/eventBadges.js';
import { computeRaffleTickets } from '../../src/services/raffle/computeTickets.js';

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
  app.use('/api/admin/events', eventsAdminRouter);
  app.use('/api/events', eventsRouter);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  clearLiveCache(db);
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

const bearer = (payload) => ({ Authorization: `Bearer ${jwt.sign(payload, JWT_SECRET)}` });
const START = new Date('2026-12-01T00:00:00+01:00');
const END = new Date('2026-12-31T23:59:00+01:00');
const day = (n, hours = 10) => new Date(START.getTime() + (n - 1) * 86400000 + hours * 3600000);

const seed = async ({ hunt = {}, goal = { enabled: false } } = {}) => {
  const users = await db.collection('users').insertMany([
    { discord_id: 'p1', username: 'one', bbs_accounts: [{ bbs_id: 'b1', bbs_name: 'One', is_primary: true }] },
    { discord_id: 'p2', username: 'two' },
  ]);
  const event = await createEvent(db, {
    name: 'Anniversaire',
    kind: 'anniversary',
    start_at: START,
    end_at: END,
    badge_name: 'Anniversaire 2026',
    advent: { enabled: true },
    hunt: { enabled: true, points: 3, tickets: 1, badge_name: 'Chasseur 2026', badge_min: 2, ...hunt },
    goal,
  });
  const eventId = event._id.toString();
  await saveSpot(db, eventId, 1, { path: '/Joueur/Ichigo%20K/', hint: 'Chez un joueur' });
  await saveSpot(db, eventId, 2, { path: '/podium', hint: 'Sur les marches' });
  return { eventId, one: { _id: users.insertedIds[0].toString() }, two: { _id: users.insertedIds[1].toString() } };
};

describe('gift hunt', () => {
  it('compares pages without query, case or trailing slash', () => {
    expect(normalizePath('/joueur/Ichigo%20K/?compte=1')).toBe('/joueur/ichigo k');
    expect(normalizePath('podium')).toBe('/podium');
  });

  it('refuses the admin and event pages and an empty hint', async () => {
    const { eventId } = await seed();
    await expect(saveSpot(db, eventId, 3, { path: '/admin', hint: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(saveSpot(db, eventId, 3, { path: '/anniversaire', hint: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(saveSpot(db, eventId, 3, { path: '/cycles', hint: '' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('shows the gift only on the page of the day, once per player', async () => {
    const { one } = await seed();
    expect(await checkPage(db, one, '/podium', day(1))).toEqual({ gift: false });
    expect(await checkPage(db, one, '/joueur/ichigo k', day(1))).toMatchObject({ gift: true, day: 1 });
    await expect(claimGift(db, one, '/podium', day(1))).rejects.toMatchObject({ statusCode: 404 });
    expect(await claimGift(db, one, '/joueur/Ichigo K', day(1))).toMatchObject({ points: 3, tickets: 1, found: 1, hunter_badge: false });
    await expect(claimGift(db, one, '/joueur/Ichigo K', day(1))).rejects.toMatchObject({ statusCode: 409 });
    expect(await checkPage(db, one, '/joueur/ichigo k', day(1))).toMatchObject({ gift: false });
    // Day 3 has no gift, and nothing is hidden once the event is over
    expect(await checkPage(db, one, '/podium', day(3))).toEqual({ gift: false });
    expect(await checkPage(db, one, '/podium', new Date(END.getTime() + 1000))).toEqual({ gift: false });
  });

  it('never tells the page, only the hint', async () => {
    const { eventId, one } = await seed();
    const view = await huntView(db, await getEventById(db, eventId), one, day(1));
    expect(view).toMatchObject({ today: 1, hint: 'Chez un joueur', found_today: false, found: 0, days: 31 });
    expect(JSON.stringify(view)).not.toContain('ichigo');
  });

  it('adds the gifts to the calendar ranking and gives both badges', async () => {
    const { eventId, one } = await seed();
    await claimGift(db, one, '/joueur/ichigo k', day(1));
    expect(await claimGift(db, one, '/podium', day(2))).toMatchObject({ found: 2, hunter_badge: true });
    const { rankings } = await getCalendar(db, eventId, one, day(2));
    expect(rankings.all[0]).toMatchObject({ name: 'One', points: 6, gifts: 2, found: 0 });
    const badges = await listUserBadges(db, one._id);
    expect(badges.map((b) => [b.kind, b.name])).toEqual([['participant', 'Anniversaire 2026'], ['hunter', 'Chasseur 2026']]);
  });

  it('gives raffle tickets to the account that found the gift, in the month it was found', async () => {
    const { one } = await seed({ hunt: { tickets: 2 } });
    await claimGift(db, one, '/joueur/ichigo k', day(1));
    const tickets = await huntTicketsBetween(db, ['b1', 'b2'], day(1, 0), day(2, 0));
    expect([...tickets]).toEqual([['b1', 2]]);
    expect((await huntTicketsBetween(db, ['b1'], day(2, 0), day(5))).size).toBe(0);

    const raffle = computeRaffleTickets({ rotations: [], scores: [], players: [{ bbs_id: 'b1', bbs_name: 'One' }], eventTickets: tickets });
    expect(raffle.players[0]).toMatchObject({ tickets: 2, breakdown: { event: 2 } });
  });

  it('suggests a page not used yet', async () => {
    const { eventId } = await seed();
    const suggestion = await randomSpot(db, eventId);
    expect(suggestion.path).toMatch(/^\//);
    expect(['/joueur/ichigo k', '/podium']).not.toContain(suggestion.path);
  });

  it('serves the routes to logged-in players and admins only', async () => {
    await seed();
    const player = bearer({ _id: (await db.collection('users').findOne({ discord_id: 'p1' }))._id.toString() });
    expect((await request(app).post('/api/events/hunt/check').send({ path: '/podium' })).status).toBe(401);
    const check = await request(app).post('/api/events/hunt/check').set(player).send({ path: '/podium' });
    expect(check.status).toBe(200);
    expect(check.body.data.gift).toBe(false);
    expect((await request(app).get('/api/events/live')).status).toBe(200);
  });
});

describe('community goal', () => {
  it('validates the tiers', () => {
    expect(sanitizeGoal({ tiers: [{ threshold: 50, reward: 'frame' }, { threshold: 10, reward: 'decor' }] }).tiers.map((t) => t.threshold)).toEqual([10, 50]);
    expect(() => sanitizeGoal({ tiers: [{ threshold: 10, reward: 'custom', label: '' }] })).toThrow('Décris');
    expect(() => sanitizeGoal({ tiers: [{ threshold: 0, reward: 'decor' }] })).toThrow('seuil');
  });

  it('fills the gauge with every contribution of the event and unlocks the tiers', async () => {
    const { eventId, one } = await seed({
      goal: {
        enabled: true,
        weights: { score: 1, advent: 3, quiz: 10, gift: 5 },
        tiers: [{ threshold: 6, reward: 'decor' }, { threshold: 7, reward: 'frame' }, { threshold: 100, reward: 'custom', label: 'Un pack' }],
      },
    });
    await db.collection('scores').insertMany([
      { score: 1000, created_at: day(1) },
      { score: 0, created_at: day(1) },
      { score: 1000, created_at: new Date(START.getTime() - 1000) },
    ]);
    await claimGift(db, one, '/joueur/ichigo k', day(1));
    const progress = await goalProgress(db, await getEventById(db, eventId), day(1, 12));
    expect(progress).toMatchObject({ total: 6, counts: { score: 1, gift: 1, advent: 0, quiz: 0 }, target: 100 });
    expect(progress.tiers.map((t) => t.reached)).toEqual([true, false, false]);

    const live = await getLiveEvent(db, day(1, 12));
    expect(live).toMatchObject({ event_id: eventId, decor: true, frame_user_ids: [], hunt: true, goal: { total: 6, target: 100 } });
  });

  it('frames the participants once the tier is reached', async () => {
    const { one } = await seed({ goal: { enabled: true, weights: { gift: 10 }, tiers: [{ threshold: 10, reward: 'frame' }] } });
    await claimGift(db, one, '/joueur/ichigo k', day(1));
    expect((await getLiveEvent(db, day(1, 12))).frame_user_ids).toEqual([one._id]);
  });

  it('has nothing live outside an event', async () => {
    await seed({ goal: { enabled: true } });
    expect(await getLiveEvent(db, new Date(END.getTime() + 1000))).toBeNull();
  });
});
