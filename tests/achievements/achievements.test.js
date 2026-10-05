import express from 'express';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { setDb } from '../../src/config/database.js';
import usersRouter from '../../src/routes/users/index.js';
import { getAchievementsForAccounts } from '../../src/services/achievements.js';
import { recordScoreChange } from '../../src/services/scoreHistory.js';

// Succès calculés à partir des scores. Les cycles des tests sont courts (2 à 10 rotations) : les
// règles s'appuient sur la taille réelle du cycle, pas sur 20 en dur.
jest.setTimeout(60000);

let mongod;
let client;
let db;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');
  setDb(db);
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map((c) => db.collection(c.name).deleteMany({})));
});

const fmt = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

// Un cycle de `size` rotations, une par jour à partir de `start` (Date) ; chaque rotation a son
// propre killer (document rotation) sauf si `rotationIds` est fourni.
const seedCycle = async (name, start, size, rotationIds = null) => {
  const ids = rotationIds || Object.values((await db.collection('rotations').insertMany(
    Array.from({ length: size }, (_, i) => ({ killer: `${name}-K${i}`, attack: 'R' }))
  )).insertedIds).map((id) => id.toString());
  const rotations = ids.map((rotation_id, i) => {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return { rotation_id, position: i + 1, start_date: fmt(day), end_date: fmt(day) };
  });
  const { insertedId } = await db.collection('cycles').insertOne({ name, year: start.getFullYear(), rotations });
  return { id: insertedId.toString(), rotations: ids };
};

const score = (cycle, ri, bbs_id, value, guild_id = 'g1') => ({
  cycle_id: cycle.id, rotation_id: cycle.rotations[ri], bbs_id, bbs_name: bbs_id.toUpperCase(),
  guild_id, score: value, raw_score: value, is_differential: false,
});

const achievementsOf = async (bbs, options = {}) => {
  const { accounts } = await getAchievementsForAccounts(db, [bbs], { fresh: true, ...options });
  return Object.fromEntries(accounts.get(bbs).map((a) => [a.code, a]));
};
const unlocked = (a) => a.tiers.filter((tr) => tr.unlocked_at !== null).map((tr) => tr.tier);

describe('score achievements', () => {
  it('counts clears and perfect scores, dates them, and ignores implausible typos', async () => {
    const c1 = await seedCycle('C1', new Date(2025, 0, 1), 2);
    await db.collection('scores').insertMany([
      score(c1, 0, 'alice', 621_500_000), score(c1, 1, 'alice', 617_000_000),
      score(c1, 0, 'bob', 911_000_000), score(c1, 1, 'bob', 100),
    ]);

    const alice = await achievementsOf('alice');
    expect(alice.clear.value).toBe(2);
    expect(unlocked(alice.perfect_score)).toEqual(['gold', 'platinum']);
    expect(alice.perfect_score.tiers.find((tr) => tr.tier === 'platinum').unlocked_at).toBe(new Date(2025, 0, 1).getTime());
    expect(alice.first_step.current_tier).toBe('bronze');

    const bob = await achievementsOf('bob');
    expect(unlocked(bob.perfect_score)).toEqual([]);
    expect(bob.clear.value).toBe(0);
  });

  it('only counts a perfect week on the two rotations of the same week', async () => {
    const c1 = await seedCycle('C1', new Date(2025, 0, 1), 4);
    await db.collection('scores').insertMany([
      score(c1, 0, 'alice', 620_000_000), score(c1, 1, 'alice', 620_100_000), // semaine 1 : parfaite
      score(c1, 2, 'alice', 620_500_000), score(c1, 3, 'alice', 500_000_000), // semaine 2 : non
    ]);
    const alice = await achievementsOf('alice');
    expect(alice.perfect_week.value).toBe(1);
    expect(alice.perfect_week.next_tier).toEqual({ tier: 'silver', threshold: 5 });
  });
});

describe('regularity achievements', () => {
  it('handles complete cycles, streaks without miss and a comeback after an absence', async () => {
    const c1 = await seedCycle('C1', new Date(2025, 0, 1), 2);
    const c2 = await seedCycle('C2', new Date(2025, 1, 1), 2);
    const c3 = await seedCycle('C3', new Date(2025, 2, 1), 2);
    await db.collection('scores').insertMany([
      score(c1, 0, 'alice', 500), score(c1, 1, 'alice', 500),
      // C2 : absente
      score(c3, 0, 'alice', 500), score(c3, 1, 'alice', 500),
      score(c2, 0, 'bob', 500), score(c2, 1, 'bob', 0), // un miss : cycle non complet
    ]);

    const alice = await achievementsOf('alice');
    expect(alice.full_cycle.value).toBe(2);
    expect(alice.comeback.current_tier).toBe('bronze');
    expect(alice.flawless.value).toBe(2); // l'absence en C2 casse la série
    expect(alice.unstoppable.value).toBe(1); // C1 et C3 ne sont pas consécutifs
    expect(alice.veteran.value).toBe(2);
    expect(alice.diligent.value).toBe(4);

    const bob = await achievementsOf('bob');
    expect(bob.full_cycle.value).toBe(0);
    expect(bob.comeback.current_tier).toBeNull();
  });
});

describe('podium, records and progression achievements', () => {
  it('ranks ended cycles only, and gives the absolute record of a killer to its holder', async () => {
    const c1 = await seedCycle('C1', new Date(2025, 0, 1), 2);
    const ongoing = await seedCycle('C2', new Date(2025, 5, 1), 2);
    await db.collection('scores').insertMany([
      score(c1, 0, 'alice', 600), score(c1, 1, 'alice', 600),
      score(c1, 0, 'bob', 500), score(c1, 1, 'bob', 500),
      score(c1, 0, 'carol', 100, 'g2'), score(c1, 1, 'carol', 100, 'g2'),
      score(ongoing, 0, 'bob', 900),
    ]);
    // Le 2 juin 2025, C2 n'est pas terminé : il ne compte pas encore pour les podiums
    const now = new Date(2025, 5, 2).getTime();

    const alice = await achievementsOf('alice', { now });
    expect(alice.number_one.current_tier).toBe('platinum');
    expect(alice.leader.value).toBe(1);
    expect(alice.podium.value).toBe(1);
    expect(alice.reference.current_tier).toBe('silver'); // record du killer K1 de C1

    const bob = await achievementsOf('bob', { now });
    expect(bob.number_one.value).toBe(0);
    expect(bob.podium.value).toBe(1);
    expect(bob.leader.value).toBe(0);
    expect(bob.reference.current_tier).toBe('silver'); // record du killer K0 de C2 (900)

    const carol = await achievementsOf('carol', { now });
    expect(carol.leader.value).toBe(1); // seule de sa guilde
    expect(carol.elite.value).toBe(1);
  });

  it('measures progression between ended cycles with enough scores, and the best of the guild', async () => {
    const shared = Object.values((await db.collection('rotations').insertMany(
      Array.from({ length: 10 }, (_, i) => ({ killer: `K${i}` }))
    )).insertedIds).map((id) => id.toString());
    const c1 = await seedCycle('C1', new Date(2025, 0, 1), 10, shared);
    const c2 = await seedCycle('C2', new Date(2025, 1, 1), 10, shared);
    const scores = [];
    for (let ri = 0; ri < 10; ri++) {
      scores.push(score(c1, ri, 'alice', 100), score(c2, ri, 'alice', 150));
      scores.push(score(c1, ri, 'bob', 100), score(c2, ri, 'bob', 110));
    }
    await db.collection('scores').insertMany(scores);

    const alice = await achievementsOf('alice');
    expect(alice.improving.value).toBe(50);
    expect(unlocked(alice.improving)).toEqual(['bronze', 'silver', 'gold']);
    expect(alice.revelation.current_tier).toBe('silver');
    expect(alice.outdone.value).toBe(10); // ses 10 scores de C2 battent ceux de C1

    const bob = await achievementsOf('bob');
    expect(unlocked(bob.improving)).toEqual(['bronze']);
    expect(bob.revelation.current_tier).toBeNull();
  });
});

describe('rarity, cache and route', () => {
  it('computes rarity over accounts and refreshes after a score change', async () => {
    const c1 = await seedCycle('C1', new Date(2025, 0, 1), 2);
    await db.collection('scores').insertMany([
      score(c1, 0, 'alice', 617_000_000), score(c1, 1, 'alice', 617_000_000),
      score(c1, 0, 'bob', 100), score(c1, 1, 'bob', 100),
    ]);

    let { accounts } = await getAchievementsForAccounts(db, ['alice']);
    const tierOf = (list, code, tier) => list.find((a) => a.code === code).tiers.find((tr) => tr.tier === tier);
    expect(tierOf(accounts.get('alice'), 'first_step', 'bronze').rarity).toBe(100);
    expect(tierOf(accounts.get('alice'), 'clear', 'bronze').unlocked_at).toBeNull(); // 2 clears sur 3

    // Nouveau score + journalisation : le cache est vidé, le 3e clear débloque le bronze
    const c2 = await seedCycle('C2', new Date(2025, 1, 1), 1);
    const added = score(c2, 0, 'alice', 618_000_000);
    await db.collection('scores').insertOne(added);
    await recordScoreChange(db, { action: 'create', after: added });

    ({ accounts } = await getAchievementsForAccounts(db, ['alice']));
    expect(tierOf(accounts.get('alice'), 'clear', 'bronze').unlocked_at).not.toBeNull();
    expect(tierOf(accounts.get('alice'), 'clear', 'bronze').rarity).toBe(50);
  });

  it('GET /api/users/:userId/achievements returns each account of the player', async () => {
    const c1 = await seedCycle('C1', new Date(2025, 0, 1), 1);
    const { insertedId } = await db.collection('users').insertOne({
      bbs_accounts: [{ bbs_id: 'alice', bbs_name: 'Alice', is_primary: true }, { bbs_id: 'alice-alt', bbs_name: 'Alt' }],
    });
    await db.collection('scores').insertOne(score(c1, 0, 'alice', 100));
    await recordScoreChange(db, { action: 'create', after: { bbs_id: 'alice', score: 100 } });

    const app = express();
    app.locals.db = db;
    app.use('/api/users', usersRouter);
    const res = await request(app).get(`/api/users/${insertedId}/achievements`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((a) => a.bbs_id)).toEqual(['alice', 'alice-alt']);
    const first = (list) => list.find((a) => a.code === 'first_step');
    expect(first(res.body.data[0].achievements).current_tier).toBe('bronze');
    expect(first(res.body.data[1].achievements).current_tier).toBeNull();
    expect(res.body.data[0].achievements).toHaveLength(26);
  });
});
