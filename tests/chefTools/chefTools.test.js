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

// Outils des chefs (scores manquants, fiche de préparation, objectifs de guilde), annonces Discord
// des succès et badge de succès sur le podium.
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

const chefToken = (guildId) => jwt.sign({ _id: new ObjectId().toString(), guild_roles: [{ guilde_id: guildId, role: 'chef' }] }, JWT_SECRET);
const adminToken = () => jwt.sign({ _id: new ObjectId().toString(), is_admin: true }, JWT_SECRET);

const fmt = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

// Guilde avec deux membres actuels (alice, bob) et un cycle passé de 4 rotations (2 semaines)
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
      .set('Authorization', `Bearer ${chefToken(ctx.guildId)}`);

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
    // Avec plusieurs guildes actives, un admin doit préciser laquelle
    await db.collection('guildes').insertOne({ name: 'Autre' });
    expect((await request(app).get('/api/scores/missing').set('Authorization', `Bearer ${adminToken()}`)).status).toBe(400);
    const other = await request(app).get('/api/scores/missing').query({ guild_id: new ObjectId().toString() })
      .set('Authorization', `Bearer ${chefToken(ctx.guildId)}`);
    expect(other.status).toBe(403);
  });
});

describe('GET /api/scores/preparation', () => {
  it('gives each member their history on the killer, best average first', async () => {
    const older = await seed({ start: new Date(2025, 0, 1) });
    await db.collection('scores').insertMany([
      score(older, 0, 'alice', 500), score(older, 0, 'bob', 300),
    ]);
    // Nouveau cycle sur le même killer (rotation réutilisée), pour la même guilde
    const { insertedId } = await db.collection('cycles').insertOne({
      name: 'Next', year: 2025, created_at: new Date(),
      rotations: [{ rotation_id: older.rotations[0], position: 1, start_date: '01/03/2025', end_date: '01/03/2025' }],
    });
    await db.collection('scores').insertOne({ ...score(older, 0, 'alice', 700), cycle_id: insertedId.toString() });

    const res = await request(app).get('/api/scores/preparation')
      .query({ cycle_id: insertedId.toString(), rotation_id: older.rotations[0] })
      .set('Authorization', `Bearer ${chefToken(older.guildId)}`);

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
      .set('Authorization', `Bearer ${chefToken(ctx.guildId)}`)
      .send({ cycle_id: ctx.cycleId, goals: [{ type: 'average', target: 550_000_000 }, { type: 'clear_rate', target: 50 }, { type: 'participation', target: 30 }] });
    expect(put.status).toBe(200);

    const res = await request(app).get(`/api/guildes/${ctx.guildId}/goals`).query({ cycle_id: ctx.cycleId });
    const byType = Object.fromEntries(res.body.goals.map((g) => [g.type, g]));
    expect(byType.average).toMatchObject({ value: 572_333_333, achieved: true });
    expect(byType.clear_rate).toMatchObject({ value: 33.3, achieved: false, progress: 66.6 });
    // 3 scores sur 2 membres × 4 rotations terminées
    expect(byType.participation).toMatchObject({ value: 37.5, achieved: true });
  });

  it('validates goals and refuses another guild', async () => {
    const ctx = await seed();
    const auth = { Authorization: `Bearer ${chefToken(ctx.guildId)}` };
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

    // Premier passage : l'historique est enregistré sans annonce
    expect(await notifyAchievementUnlocks(db, [score(ctx, 0, 'alice', 0)])).toBe(0);
    expect(await db.collection('achievement_unlocks').countDocuments({ bbs_id: 'alice', code: 'perfect_score' })).toBe(2);

    // Bob réalise un score parfait : or et platine annoncés une seule fois
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
    // Le platine de "Score parfait" n'est détenu que par alice : c'est son succès le plus rare
    expect(alice.top_achievement).toMatchObject({ code: 'perfect_score', tier: 'platinum', name: 'Score parfait' });
    expect(bob.top_achievement).toMatchObject({ tier: 'bronze' });
  });
});
