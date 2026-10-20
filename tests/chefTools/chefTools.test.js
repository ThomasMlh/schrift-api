import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import { setDb } from '../../src/config/database.js';
import scoresRouter from '../../src/routes/scores/index.js';
import guildesRouter from '../../src/routes/guildes/index.js';
import { notifyAchievementUnlocks } from '../../src/services/achievementAnnouncements.js';
import { invalidateAchievementsCache } from '../../src/services/achievements.js';
import { getPodiumFull } from '../../src/services/podiumService/index.js';
import { getCycleRecap } from '../../src/services/cycleRecap.js';

// Leader tools (missing scores, preparation sheet, guild goals), Discord achievement announcements
// and the achievement badge on the podium.
jest.setTimeout(60000);

const JWT_SECRET = 'test-secret';

let mongod;
let client;
let db;
let app;
let originalFetch;

beforeAll(async () => {
  process.env.JWT_SECRET = JWT_SECRET;
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');
  setDb(db);
  originalFetch = globalThis.fetch;
  globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => '' });

  app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/api/scores', scoresRouter);
  app.use('/api/guildes', guildesRouter);
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  invalidateAchievementsCache();
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

// The middleware reads leader grants from the database: the chef's user must exist there
const chefToken = async (guildId) => {
  const _id = new ObjectId();
  await db.collection('users').insertOne({ _id, bbs_accounts: [{ guilde_id: guildId, role: 'chef' }] });
  return jwt.sign({ _id: _id.toString() }, JWT_SECRET);
};
const adminToken = () => jwt.sign({ _id: new ObjectId().toString(), is_admin: true }, JWT_SECRET);

const fmt = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

// Guild with two current members (alice, bob) and a past cycle of 4 rotations (2 weeks)
const seed = async ({ start = new Date(2025, 0, 1), rotationIds = null } = {}) => {
  const { insertedId: guildOid } = await db.collection('guildes').insertOne({ name: 'Les Quincy', discord_general_channel_id: 'chan-1' });
  const guildId = guildOid.toString();
  const users = await db.collection('users').insertMany([
    { username: 'alice', global_name: 'Alice', bbs_accounts: [{ bbs_id: 'alice', bbs_name: 'ALICE', guilde_id: guildId }] },
    { username: 'bob', global_name: 'Bob', bbs_accounts: [{ bbs_id: 'bob', bbs_name: 'BOB', guilde_id: guildId }] },
  ]);
  const ids = rotationIds || Object.values((await db.collection('rotations').insertMany(
    [{ killer: 'Arrancar', attack: 'R' }, { killer: 'Espada', attack: 'B' }, { killer: 'Hollow', attack: 'R' }, { killer: 'Quincy', attack: 'B' }]
  )).insertedIds).map((id) => id.toString());
  const rotations = ids.map((rotation_id, i) => {
    const day = fmt(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
    return { rotation_id, position: i + 1, start_date: day, end_date: day };
  });
  const { insertedId: cycleOid } = await db.collection('cycles').insertOne({ name: `C-${start.getTime()}`, year: start.getFullYear(), rotations, created_at: new Date() });
  return { guildId, cycleId: cycleOid.toString(), cycleName: `C-${start.getTime()}`, rotations: ids, userIds: Object.values(users.insertedIds).map((i) => i.toString()) };
};

const score = (ctx, ri, bbs_id, value, extra = {}) => ({
  cycle_id: ctx.cycleId, rotation_id: ctx.rotations[ri], bbs_id, bbs_name: bbs_id.toUpperCase(), user_id: 'u',
  guild_id: ctx.guildId, score: value, raw_score: value, is_differential: false, ...extra,
});

describe('GET /api/scores/missing', () => {
  it('lists, per ended rotation (latest first), the current members without a score', async () => {
    const ctx = await seed();
    await db.collection('scores').insertMany([
      score(ctx, 0, 'alice', 100), score(ctx, 0, 'bob', 100),
      score(ctx, 1, 'alice', 100),
    ]);

    const res = await request(app).get('/api/scores/missing').query({ cycle_id: ctx.cycleId })
      .set('Authorization', `Bearer ${await chefToken(ctx.guildId)}`);

    expect(res.status).toBe(200);
    expect(res.body.members_count).toBe(2);
    expect(res.body.rotations.map((r) => [r.position, r.missing.map((m) => m.bbs_id)])).toEqual([
      [4, ['alice', 'bob']], [3, ['alice', 'bob']], [2, ['bob']], [1, []],
    ]);
    expect(res.body.rotations.find((r) => r.position === 2)).toMatchObject({ killer: 'Espada', is_differential: true });
    expect(res.body.rotations[0].missing[0].user_id).toBe(ctx.userIds[0]);
  });

  it('requires a guild for admins and refuses another guild to a chef', async () => {
    const ctx = await seed();
    // With several active guilds, an admin must specify one
    await db.collection('guildes').insertOne({ name: 'Autre' });
    expect((await request(app).get('/api/scores/missing').set('Authorization', `Bearer ${adminToken()}`)).status).toBe(400);
    const other = await request(app).get('/api/scores/missing').query({ guild_id: new ObjectId().toString() })
      .set('Authorization', `Bearer ${await chefToken(ctx.guildId)}`);
    expect(other.status).toBe(403);
  });
});

describe('missing scores of members who joined during the cycle', () => {
  it('skips the rotations that ended before the member joined the guild', async () => {
    const ctx = await seed();
    await db.collection('users').updateOne(
      { 'bbs_accounts.bbs_id': 'bob' },
      { $set: { 'bbs_accounts.0.guild_joined_at': new Date(2025, 0, 3, 12) } }
    );

    const res = await request(app).get('/api/scores/missing').query({ cycle_id: ctx.cycleId })
      .set('Authorization', `Bearer ${await chefToken(ctx.guildId)}`);

    expect(res.body.rotations.map((r) => [r.position, r.missing.map((m) => m.bbs_id)])).toEqual([
      [4, ['alice', 'bob']], [3, ['alice', 'bob']], [2, ['alice']], [1, ['alice']],
    ]);
  });

  it('lets a chef mark that a member joined after a rotation', async () => {
    const ctx = await seed();
    const auth = { Authorization: `Bearer ${await chefToken(ctx.guildId)}` };

    const res = await request(app).post('/api/scores/missing/joined-after').set(auth)
      .send({ bbs_id: 'bob', cycle_id: ctx.cycleId, rotation_id: ctx.rotations[2] });
    expect(res.status).toBe(200);

    const missing = await request(app).get('/api/scores/missing').query({ cycle_id: ctx.cycleId }).set(auth);
    expect(missing.body.rotations.map((r) => [r.position, r.missing.map((m) => m.bbs_id)])).toEqual([
      [4, ['alice', 'bob']], [3, ['alice']], [2, ['alice']], [1, ['alice']],
    ]);

    const unknown = await request(app).post('/api/scores/missing/joined-after').set(auth)
      .send({ bbs_id: 'nobody', cycle_id: ctx.cycleId, rotation_id: ctx.rotations[2] });
    expect(unknown.status).toBe(404);
  });
});

describe('GET /api/scores/preparation', () => {
  it('gives each member their history on the killer, best average first', async () => {
    const older = await seed({ start: new Date(2025, 0, 1) });
    await db.collection('scores').insertMany([
      score(older, 0, 'alice', 500), score(older, 0, 'bob', 300),
    ]);
    // New cycle on the same killer (reused rotation), for the same guild
    const { insertedId } = await db.collection('cycles').insertOne({
      name: 'Next', year: 2025, created_at: new Date(),
      rotations: [{ rotation_id: older.rotations[0], position: 1, start_date: '01/03/2025', end_date: '01/03/2025' }],
    });
    await db.collection('scores').insertOne({ ...score(older, 0, 'alice', 700), cycle_id: insertedId.toString() });

    const res = await request(app).get('/api/scores/preparation')
      .query({ cycle_id: insertedId.toString(), rotation_id: older.rotations[0] })
      .set('Authorization', `Bearer ${await chefToken(older.guildId)}`);

    expect(res.status).toBe(200);
    expect(res.body.rotation).toMatchObject({ killer: 'Arrancar', position: 1 });
    expect(res.body.killer_stats).toEqual({ attempts: 3, average: 500, record: 700 });
    expect(res.body.members.map((m) => [m.bbs_id, m.attempts, m.best, m.average, m.this_cycle])).toEqual([
      ['alice', 2, 700, 600, 700],
      ['bob', 1, 300, 300, null],
    ]);
    expect(res.body.members[0].last).toMatchObject({ score: 700, cycle_name: 'Next' });
  });
});

describe('guild goals', () => {
  it('lets a chef set goals for their guild and reports their progress', async () => {
    const ctx = await seed();
    await db.collection('scores').insertMany([
      score(ctx, 0, 'alice', 617_000_000), score(ctx, 1, 'alice', 600_000_000),
      score(ctx, 0, 'bob', 500_000_000),
    ]);

    const put = await request(app).put(`/api/guildes/${ctx.guildId}/goals`)
      .set('Authorization', `Bearer ${await chefToken(ctx.guildId)}`)
      .send({ cycle_id: ctx.cycleId, goals: [{ type: 'average', target: 550_000_000 }, { type: 'clear_rate', target: 50 }, { type: 'participation', target: 30 }] });
    expect(put.status).toBe(200);

    const res = await request(app).get(`/api/guildes/${ctx.guildId}/goals`).query({ cycle_id: ctx.cycleId });
    const byType = Object.fromEntries(res.body.goals.map((g) => [g.type, g]));
    expect(byType.average).toMatchObject({ value: 572_333_333, achieved: true });
    expect(byType.clear_rate).toMatchObject({ value: 33.3, achieved: false, progress: 66.6 });
    // 3 scores out of 2 members × 4 finished rotations
    expect(byType.participation).toMatchObject({ value: 37.5, achieved: true });
  });

  it('only expects participation from the rotations after a member joined', async () => {
    const ctx = await seed();
    await db.collection('users').updateOne(
      { 'bbs_accounts.bbs_id': 'bob' },
      { $set: { 'bbs_accounts.0.guild_joined_at': new Date(2025, 0, 3, 12) } }
    );
    await db.collection('scores').insertMany([
      score(ctx, 0, 'alice', 100), score(ctx, 1, 'alice', 100),
      // Before bob joined: neither expected nor counted
      score(ctx, 0, 'bob', 100), score(ctx, 2, 'bob', 100),
    ]);
    await db.collection('guild_goals').insertOne({ guild_id: ctx.guildId, cycle_id: ctx.cycleId, goals: [{ type: 'participation', target: 50 }] });

    const res = await request(app).get(`/api/guildes/${ctx.guildId}/goals`).query({ cycle_id: ctx.cycleId });
    // 3 scores out of 4 (alice) + 2 (bob, rotations 3 and 4) expected
    expect(res.body.goals[0]).toMatchObject({ value: 50, achieved: true });
  });

  it('validates goals and refuses another guild', async () => {
    const ctx = await seed();
    const auth = { Authorization: `Bearer ${await chefToken(ctx.guildId)}` };
    expect((await request(app).put(`/api/guildes/${ctx.guildId}/goals`).set(auth).send({ cycle_id: ctx.cycleId, goals: [{ type: 'nope', target: 1 }] })).status).toBe(400);
    expect((await request(app).put(`/api/guildes/${ctx.guildId}/goals`).set(auth).send({ cycle_id: ctx.cycleId, goals: [{ type: 'clear_rate', target: 150 }] })).status).toBe(400);
    expect((await request(app).put(`/api/guildes/${new ObjectId()}/goals`).set(auth).send({ cycle_id: ctx.cycleId, goals: [] })).status).toBe(403);
  });

  it('appears in the end-of-cycle recap', async () => {
    const ctx = await seed();
    await db.collection('scores').insertOne(score(ctx, 0, 'alice', 600));
    await db.collection('guild_goals').insertOne({ guild_id: ctx.guildId, cycle_id: ctx.cycleId, goals: [{ type: 'average', target: 500 }] });
    const cycle = await db.collection('cycles').findOne({ _id: new ObjectId(ctx.cycleId) });
    const guild = await db.collection('guildes').findOne({ _id: new ObjectId(ctx.guildId) });

    const recap = await getCycleRecap(db, cycle, guild);
    expect(recap.goals).toEqual([{ type: 'average', unit: 'score', target: 500, value: 600, achieved: true }]);
  });
});

describe('achievement announcements and podium badge', () => {
  it('seeds silently the first time, then announces only newly unlocked gold/platinum tiers', async () => {
    const ctx = await seed();
    await db.collection('scores').insertOne(score(ctx, 0, 'alice', 621_500_000));

    // First run: history is recorded without announcements
    expect(await notifyAchievementUnlocks(db, [score(ctx, 0, 'alice', 0)])).toBe(0);
    expect(await db.collection('achievement_unlocks').countDocuments({ bbs_id: 'alice', code: 'perfect_score' })).toBe(2);

    // Bob makes a perfect score: gold and platinum are announced once
    const bobScore = score(ctx, 1, 'bob', 621_100_000);
    await db.collection('scores').insertOne(bobScore);
    expect(await notifyAchievementUnlocks(db, [bobScore])).toBe(1);
    const logged = await db.collection('activity_log').find({ type: 'achievement_unlock' }).toArray();
    expect(logged).toHaveLength(1);
    expect(logged[0].channel_id).toBe('chan-1');
    expect(logged[0].data.unlocks).toEqual([expect.objectContaining({ pseudo: 'BOB', code: 'perfect_score', tier: 'gold', tier_label: 'Or', name: 'Score parfait' })]);

    expect(await notifyAchievementUnlocks(db, [bobScore])).toBe(0);
  });

  it('adds the rarest achievement of each account to podium rows', async () => {
    const ctx = await seed();
    await db.collection('scores').insertMany([score(ctx, 0, 'alice', 621_500_000), score(ctx, 0, 'bob', 100)]);

    const result = await getPodiumFull(db, { cycle_name: ctx.cycleName });
    const alice = result.data.find((r) => r.bbs_id === 'alice');
    const bob = result.data.find((r) => r.bbs_id === 'bob');
    // Only alice holds the "Score parfait" platinum: it is her rarest achievement
    expect(alice.top_achievement).toMatchObject({ code: 'perfect_score', tier: 'platinum', name: 'Score parfait' });
    expect(bob.top_achievement).toMatchObject({ tier: 'bronze' });
  });
});
