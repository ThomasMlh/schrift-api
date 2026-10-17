import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import { setDb } from '../../src/config/database.js';
import scoresRouter from '../../src/routes/scores/index.js';
import { recordScoreChange } from '../../src/services/scoreHistory.js';
import { getScoreAnomalies } from '../../src/services/scoreAnomalies.js';

// Score control: change history (logged by the write routes) and detection of scores to review,
// with the leader scope (their guild) / admin scope (everything).
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
  setDb(db); // notifyDiscord logs to activity_log through getDB()
  originalFetch = globalThis.fetch;
  globalThis.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => '' });

  app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/api/scores', scoresRouter);
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

const adminId = new ObjectId();
const adminToken = () => jwt.sign({ _id: adminId.toString(), is_admin: true }, JWT_SECRET);
const chefToken = (guildId) => jwt.sign({ _id: new ObjectId().toString(), guild_roles: [{ guilde_id: guildId, role: 'chef' }] }, JWT_SECRET);

// One guild, one member (alice) and a cycle of 2 rotations (base + differential)
const seed = async () => {
  const { insertedId: guildOid } = await db.collection('guildes').insertOne({ name: 'Les Quincy' });
  const guildId = guildOid.toString();
  const { insertedId: userOid } = await db.collection('users').insertOne({
    username: 'alice', bbs_accounts: [{ bbs_id: 'bbs-alice', bbs_name: 'Alice', guilde_id: guildId }],
  });
  await db.collection('users').insertOne({ _id: adminId, global_name: 'Admin' });
  const { insertedIds } = await db.collection('rotations').insertMany([{ killer: 'Arrancar', attack: 'R' }, { killer: 'Espada', attack: 'B' }]);
  const [r1, r2] = Object.values(insertedIds).map((id) => id.toString());
  const { insertedId: cycleOid } = await db.collection('cycles').insertOne({
    name: 'C1', year: 2026,
    rotations: [{ rotation_id: r1, position: 1, start_date: '01/01/2026' }, { rotation_id: r2, position: 2, start_date: '01/01/2026' }],
  });
  return { guildId, userId: userOid.toString(), cycleId: cycleOid.toString(), r1, r2 };
};

describe('score history', () => {
  it('records creation, correction (with the automatic differential recalculation) and author', async () => {
    const { guildId, userId, cycleId, r1, r2 } = await seed();
    const auth = { Authorization: `Bearer ${adminToken()}` };

    const base = await request(app).post('/api/scores').set(auth)
      .send({ user_id: userId, bbs_id: 'bbs-alice', cycle_id: cycleId, rotation_id: r1, guild_id: guildId, raw_score: 100 });
    expect(base.status).toBe(201);
    await request(app).post('/api/scores').set(auth)
      .send({ user_id: userId, bbs_id: 'bbs-alice', cycle_id: cycleId, rotation_id: r2, guild_id: guildId, raw_score: 250 });

    // Correcting the base score recomputes the following differential automatically
    const edit = await request(app).put(`/api/scores/${base.body.id}`).set(auth).send({ score: 120 });
    expect(edit.status).toBe(200);

    const res = await request(app).get('/api/scores/history').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e) => e.action)).toEqual(['recalculate', 'update', 'create', 'create']);
    const [recalc, update] = res.body.entries;
    expect(update).toMatchObject({
      score_id: base.body.id, bbs_name: 'Alice', guild_name: 'Les Quincy', cycle_name: 'C1', killer: 'Arrancar',
      rotation_position: 1, before: { score: 100 }, after: { score: 120 }, by_name: 'Admin',
    });
    expect(recalc).toMatchObject({ source: 'auto', by_user_id: null, before: { score: 150 }, after: { score: 130 } });
  });

  it('skips a change that does not modify anything', async () => {
    const before = { _id: new ObjectId(), score: 10, raw_score: 10, bbs_id: 'b', guild_id: 'g' };
    await recordScoreChange(db, { action: 'update', before, after: { score: 10, updated_at: new Date() } });
    expect(await db.collection('score_history').countDocuments()).toBe(0);
  });

  it('limits a chef to the history of their guild and filters by score', async () => {
    const own = new ObjectId().toString();
    const other = new ObjectId().toString();
    const scoreId = new ObjectId();
    await recordScoreChange(db, { action: 'create', scoreId, after: { score: 1, bbs_id: 'a', guild_id: own } });
    await recordScoreChange(db, { action: 'create', after: { _id: new ObjectId(), score: 2, bbs_id: 'b', guild_id: other } });
    // A score transferred FROM the leader's guild stays visible to them
    await recordScoreChange(db, { action: 'update', before: { _id: new ObjectId(), score: 3, bbs_id: 'c', guild_id: own }, after: { guild_id: other } });

    const res = await request(app).get('/api/scores/history').set('Authorization', `Bearer ${chefToken(own)}`);
    expect(res.body.entries.map((e) => e.bbs_id).sort()).toEqual(['a', 'c']);

    const forbidden = await request(app).get('/api/scores/history').query({ guild_id: other }).set('Authorization', `Bearer ${chefToken(own)}`);
    expect(forbidden.status).toBe(403);

    const byScore = await request(app).get('/api/scores/history').query({ score_id: scoreId.toString() }).set('Authorization', `Bearer ${adminToken()}`);
    expect(byScore.body.entries).toHaveLength(1);
    expect(byScore.body.pagination.totalCount).toBe(1);
  });
});

describe('score anomalies', () => {
  const score = (cycle_id, rotation_id, bbs_id, value, guild_id, extra = {}) => ({
    cycle_id, rotation_id, bbs_id, bbs_name: bbs_id.toUpperCase(), guild_id, score: value, raw_score: value, is_differential: false, ...extra,
  });

  // History: 6 players around 500 on killer r1 in a previous cycle
  const seedHistory = async () => {
    const { insertedIds } = await db.collection('rotations').insertMany([{ killer: 'Arrancar', attack: 'R' }, { killer: 'Espada', attack: 'B' }]);
    const [r1, r2] = Object.values(insertedIds).map((id) => id.toString());
    const { insertedId: oldOid } = await db.collection('cycles').insertOne({
      name: 'Old', year: 2026, rotations: [{ rotation_id: r1, position: 1, start_date: '01/01/2026' }, { rotation_id: r2, position: 2, start_date: '01/01/2026' }],
    });
    const { insertedId: curOid } = await db.collection('cycles').insertOne({
      name: 'Now', year: 2026, rotations: [{ rotation_id: r1, position: 1, start_date: '01/03/2026' }, { rotation_id: r2, position: 2, start_date: '01/03/2026' }],
    });
    const { insertedId: guildOid } = await db.collection('guildes').insertOne({ name: 'Les Quincy' });
    const guildId = guildOid.toString();
    const old = oldOid.toString();
    await db.collection('scores').insertMany(
      ['p1', 'p2', 'p3', 'p4', 'p5', 'alice', 'bob'].map((p) => score(old, r1, p, 500, 'elsewhere'))
    );
    return { r1, r2, current: curOid.toString(), guildId };
  };

  it('flags typos, missing base scores and copy-pasted values; ignores normal scores', async () => {
    const { r1, r2, current, guildId } = await seedHistory();
    await db.collection('scores').insertMany([
      score(current, r1, 'alice', 5000, guildId), // Extra digit
      score(current, r1, 'bob', 50, guildId), // Missing digit
      score(current, r1, 'p1', 510, guildId), // Normal
      score(current, r2, 'p2', 777, guildId, { is_differential: true }), // No base score this week for p2
      score(current, r1, 'p3', 480, guildId), score(current, r1, 'p4', 480, guildId), // Same value
    ]);

    const anomalies = await getScoreAnomalies(db, { guildIds: [guildId] });
    const byPlayer = Object.fromEntries(anomalies.map((a) => [a.bbs_id, a.issues.map((i) => i.type).sort()]));

    expect(byPlayer).toEqual({
      alice: ['above_killer_record', 'far_above_usual'],
      bob: ['far_below_usual'],
      p2: ['missing_base'],
      p3: ['same_value'],
      p4: ['same_value'],
    });
    const alice = anomalies.find((a) => a.bbs_id === 'alice');
    expect(alice).toMatchObject({ killer: 'Arrancar', cycle_name: 'Now', rotation_position: 1, guild_name: 'Les Quincy' });
    // Reference = best score of the OTHERS on this killer (p1, 510, this cycle)
    expect(alice.issues.find((i) => i.type === 'above_killer_record').reference).toBe(510);
    expect(anomalies.find((a) => a.bbs_id === 'p3').issues[0].with).toEqual(['P4']);
  });

  it('hides a reviewed score until its value changes, and scopes reviews to the chef guild', async () => {
    const { r1, current, guildId } = await seedHistory();
    const { insertedId } = await db.collection('scores').insertOne(score(current, r1, 'alice', 5000, guildId));

    const other = await request(app).post(`/api/scores/${insertedId}/anomaly-review`)
      .set('Authorization', `Bearer ${chefToken(new ObjectId().toString())}`);
    expect(other.status).toBe(403);

    const reviewed = await request(app).post(`/api/scores/${insertedId}/anomaly-review`).set('Authorization', `Bearer ${chefToken(guildId)}`);
    expect(reviewed.status).toBe(200);
    const res = await request(app).get('/api/scores/anomalies').set('Authorization', `Bearer ${chefToken(guildId)}`);
    expect(res.body.anomalies).toEqual([]);

    await db.collection('scores').updateOne({ _id: insertedId }, { $set: { score: 6000, raw_score: 6000 } });
    expect(await getScoreAnomalies(db, { guildIds: [guildId] })).toHaveLength(1);
  });
});
