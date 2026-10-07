import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import {
  getPodium,
  getPodiumFull,
  getPodiumWeekly,
  getPodiumMisses,
  getDraftProposal,
  getDraftReplacement,
  isCycleInProgress,
} from '../../src/services/podiumService/index.js';

// Tests d'intégration exerçant les vrais pipelines d'agrégation MongoDB (les
// tests unitaires de podiumService.test.js ne couvrent que les fonctions pures
// autour). mongodb-memory-server démarre un vrai mongod éphémère en local :
// pas de mock d'aggregate() à maintenir, le comportement testé est le
// comportement réel de Mongo sur ces pipelines.
jest.setTimeout(60000);

let mongod;
let client;
let db;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

afterEach(async () => {
  const collections = await db.listCollections().toArray();
  await Promise.all(collections.map(c => db.collection(c.name).deleteMany({})));
});

// --- Fixtures -----------------------------------------------------------

const makeGuild = async (name) => {
  const { insertedId } = await db.collection('guildes').insertOne({ name });
  return insertedId.toString();
};

const makeUser = async ({ discordId, bbsAccounts = [], avatar = null, globalName = null }) => {
  await db.collection('users').insertOne({
    discord_id: discordId,
    global_name: globalName,
    avatar,
    bbs_accounts: bbsAccounts,
  });
};

const makeCycle = async ({ name, year = 2026, rotations }) => {
  const { insertedId } = await db.collection('cycles').insertOne({ name, year, rotations, created_at: new Date() });
  return { _id: insertedId, name, year, rotations };
};

const makeRotationMeta = (rotationId, position) => ({
  rotation_id: rotationId,
  position,
  start_date: new Date(2026, 0, position),
  end_date: new Date(2026, 0, position + 1),
  period: `Semaine ${position}`,
});

const insertScore = (cycleId, { bbsId, bbsName, userId, guildId, rotationId, score, rawScore }) =>
  db.collection('scores').insertOne({
    cycle_id: cycleId,
    rotation_id: rotationId,
    bbs_id: bbsId,
    bbs_name: bbsName,
    user_id: userId,
    guild_id: guildId,
    score,
    raw_score: rawScore ?? score,
  });

// --- getPodium ------------------------------------------------------------

describe('getPodium (integration)', () => {
  it('ranks players by average score, descending', async () => {
    const guildId = await makeGuild('Guilde A');
    const cycle = await makeCycle({ name: 'Cycle 1', rotations: [makeRotationMeta('r1', 1)] });
    const cycleId = cycle._id.toString();

    await insertScore(cycleId, { bbsId: 'bbs-1', bbsName: 'Alice', userId: 'u1', guildId, rotationId: 'r1', score: 100 });
    await insertScore(cycleId, { bbsId: 'bbs-2', bbsName: 'Bob', userId: 'u2', guildId, rotationId: 'r1', score: 300 });

    const { podium } = await getPodium(db, { cycle_id: cycleId });

    expect(podium.map(p => p.bbs_name)).toEqual(['Bob', 'Alice']);
    expect(podium[0].rank).toBe(1);
  });

  it('excludes players below the configured min-scores-for-ranking threshold', async () => {
    const cycle = await makeCycle({ name: 'Cycle 1', rotations: [makeRotationMeta('r1', 1), makeRotationMeta('r2', 2)] });
    const cycleId = cycle._id.toString();
    await db.collection('app_settings').insertOne({ _id: 'podium', min_scores_for_ranking: 2 });

    // Alice : 1 seul score, très haut -> doit être exclue malgré son score
    await insertScore(cycleId, { bbsId: 'bbs-1', bbsName: 'Alice', userId: 'u1', guildId: null, rotationId: 'r1', score: 999 });
    // Bob : 2 scores -> passe le seuil
    await insertScore(cycleId, { bbsId: 'bbs-2', bbsName: 'Bob', userId: 'u2', guildId: null, rotationId: 'r1', score: 50 });
    await insertScore(cycleId, { bbsId: 'bbs-2', bbsName: 'Bob', userId: 'u2', guildId: null, rotationId: 'r2', score: 60 });

    const { podium, meta } = await getPodium(db, { cycle_id: cycleId });

    expect(podium.map(p => p.bbs_name)).toEqual(['Bob']);
    expect(meta.minScoresRequired).toBe(2);
  });

  it('scopes results to the current guild roster via guild_id, not the score snapshot', async () => {
    const guildA = await makeGuild('Guilde A');
    const guildB = await makeGuild('Guilde B');
    await makeUser({ discordId: 'd1', bbsAccounts: [{ bbs_id: 'bbs-1', guilde_id: guildA }] });
    await makeUser({ discordId: 'd2', bbsAccounts: [{ bbs_id: 'bbs-2', guilde_id: guildB }] });

    const cycle = await makeCycle({ name: 'Cycle 1', rotations: [makeRotationMeta('r1', 1)] });
    const cycleId = cycle._id.toString();
    await insertScore(cycleId, { bbsId: 'bbs-1', bbsName: 'Alice', userId: 'd1', guildId: guildA, rotationId: 'r1', score: 100 });
    await insertScore(cycleId, { bbsId: 'bbs-2', bbsName: 'Bob', userId: 'd2', guildId: guildB, rotationId: 'r1', score: 900 });

    const { podium } = await getPodium(db, { cycle_id: cycleId, guild_id: guildA });

    expect(podium).toHaveLength(1);
    expect(podium[0].bbs_name).toBe('Alice');
  });

  it('throws a 400 error when cycle_id is missing', async () => {
    await expect(getPodium(db, {})).rejects.toMatchObject({ statusCode: 400 });
  });
});

// --- getPodiumFull ----------------------------------------------------------

describe('getPodiumFull (integration)', () => {
  it('resolves the cycle by name and ranks by average by default', async () => {
    const cycle = await makeCycle({ name: 'Cycle Full', rotations: [makeRotationMeta('r1', 1)] });
    const cycleId = cycle._id.toString();
    await insertScore(cycleId, { bbsId: 'bbs-1', bbsName: 'Alice', userId: 'u1', guildId: null, rotationId: 'r1', score: 100 });
    await insertScore(cycleId, { bbsId: 'bbs-2', bbsName: 'Bob', userId: 'u2', guildId: null, rotationId: 'r1', score: 200 });

    const result = await getPodiumFull(db, { cycle_name: 'Cycle Full' });

    expect(result.data.map(p => p.bbs_name)).toEqual(['Bob', 'Alice']);
    expect(result.meta.podiumType).toBe('average_scores');
  });

  it('does not apply the min-scores threshold to max ranking', async () => {
    const cycle = await makeCycle({ name: 'Cycle Max', rotations: [makeRotationMeta('r1', 1), makeRotationMeta('r2', 2)] });
    const cycleId = cycle._id.toString();
    await db.collection('app_settings').insertOne({ _id: 'podium', min_scores_for_ranking: 5 });

    await insertScore(cycleId, { bbsId: 'bbs-1', bbsName: 'Alice', userId: 'u1', guildId: null, rotationId: 'r1', score: 100 });

    const result = await getPodiumFull(db, { cycle_name: 'Cycle Max', ranking_type: 'max' });

    // Un seul score, très en dessous du seuil de 5 : exclue en 'average', présente en 'max'.
    expect(result.data.map(p => p.bbs_name)).toEqual(['Alice']);
    expect(result.meta.minScoresRequired).toBeUndefined();
  });

  it('returns individual scores (no grouping) when rotation_id is given', async () => {
    // getPodiumFull résout rotation_id via new ObjectId(...) sur la collection 'rotations' :
    // il faut un vrai ObjectId, pas un id arbitraire comme dans les autres tests de ce fichier.
    const rotationId = new ObjectId().toString();
    await db.collection('rotations').insertOne({ _id: new ObjectId(rotationId), killer: 'Killer A', attack: 'Rouge' });
    const cycle = await makeCycle({ name: 'Cycle Rot', rotations: [makeRotationMeta(rotationId, 1)] });
    const cycleId = cycle._id.toString();
    await insertScore(cycleId, { bbsId: 'bbs-1', bbsName: 'Alice', userId: 'u1', guildId: null, rotationId, score: 100 });
    await insertScore(cycleId, { bbsId: 'bbs-1', bbsName: 'Alice', userId: 'u1', guildId: null, rotationId, score: 999 });

    const result = await getPodiumFull(db, { cycle_name: 'Cycle Rot', rotation_id: rotationId });

    // Pas de $group par rotation_id : les deux scores du même joueur remontent séparément.
    expect(result.data).toHaveLength(2);
    expect(result.meta.podiumType).toBe('individual_scores');
  });

  it('throws a 404 when the cycle name does not exist', async () => {
    await expect(getPodiumFull(db, { cycle_name: 'Nope' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('throws a 400 for an invalid ranking_type', async () => {
    await makeCycle({ name: 'Cycle X', rotations: [] });
    await expect(getPodiumFull(db, { cycle_name: 'Cycle X', ranking_type: 'banana' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});

// --- getPodiumWeekly --------------------------------------------------------

describe('getPodiumWeekly (integration)', () => {
  it('sums the two rotations of the requested week', async () => {
    const rotation1Id = new ObjectId().toString();
    const rotation2Id = new ObjectId().toString();
    await db.collection('rotations').insertMany([
      { _id: new ObjectId(rotation1Id), killer: 'Killer A', attack: 'Rouge' },
      { _id: new ObjectId(rotation2Id), killer: 'Killer B', attack: 'Bleue' },
    ]);
    const cycle = await makeCycle({
      name: 'Cycle Week',
      rotations: [makeRotationMeta(rotation1Id, 1), makeRotationMeta(rotation2Id, 2)],
    });
    const cycleId = cycle._id.toString();

    await insertScore(cycleId, { bbsId: 'bbs-1', bbsName: 'Alice', userId: 'u1', guildId: null, rotationId: rotation1Id, score: 100 });
    await insertScore(cycleId, { bbsId: 'bbs-1', bbsName: 'Alice', userId: 'u1', guildId: null, rotationId: rotation2Id, score: 50 });

    const result = await getPodiumWeekly(db, { cycle_name: 'Cycle Week', week_number: '1' });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].week_total_score).toBe(150);
    expect(result.data[0].rotation1_score).toBe(100);
    expect(result.data[0].rotation2_score).toBe(50);
  });

  it('rejects a cycle with an odd number of rotations', async () => {
    await makeCycle({ name: 'Cycle Odd', rotations: [makeRotationMeta('r1', 1)] });
    await expect(getPodiumWeekly(db, { cycle_name: 'Cycle Odd', week_number: '1' }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a week number beyond the cycle length', async () => {
    await makeCycle({ name: 'Cycle Short', rotations: [makeRotationMeta('r1', 1), makeRotationMeta('r2', 2)] });
    await expect(getPodiumWeekly(db, { cycle_name: 'Cycle Short', week_number: '5' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

// --- getPodiumMisses ---------------------------------------------------------

describe('getPodiumMisses (integration)', () => {
  it('only counts scores <= 0 and ranks by most misses first', async () => {
    const cycle = await makeCycle({ name: 'Cycle Misses', rotations: [makeRotationMeta('r1', 1), makeRotationMeta('r2', 2)] });
    const cycleId = cycle._id.toString();

    await insertScore(cycleId, { bbsId: 'bbs-1', bbsName: 'Alice', userId: 'u1', guildId: null, rotationId: 'r1', score: 0 });
    await insertScore(cycleId, { bbsId: 'bbs-1', bbsName: 'Alice', userId: 'u1', guildId: null, rotationId: 'r2', score: -5 });
    await insertScore(cycleId, { bbsId: 'bbs-2', bbsName: 'Bob', userId: 'u2', guildId: null, rotationId: 'r1', score: 100 });

    const result = await getPodiumMisses(db, { cycle_name: 'Cycle Misses' });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].bbs_name).toBe('Alice');
    expect(result.data[0].total_misses).toBe(2);
    expect(result.meta.totalMissesInCycle).toBe(2);
  });
});

// --- Périmètre d'une guilde : cycle passé vs cycle en cours -------------------

describe('guild scope on past and in-progress cycles', () => {
  const ddmmyyyy = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  const DAY = 24 * 60 * 60 * 1000;

  // Alice a joué pour la guilde A, puis a été transférée dans la guilde B (draft)
  const seedTransfer = async (rotations) => {
    const guildA = await makeGuild('Guilde A');
    const guildB = await makeGuild('Guilde B');
    await makeUser({ discordId: 'd1', bbsAccounts: [{ bbs_id: 'bbs-alice', guilde_id: guildB }] });
    await makeUser({ discordId: 'd2', bbsAccounts: [{ bbs_id: 'bbs-bob', guilde_id: guildA }] });
    const cycle = await makeCycle({ name: 'Cycle Scope', rotations });
    const cycleId = cycle._id.toString();
    await insertScore(cycleId, { bbsId: 'bbs-alice', bbsName: 'Alice', userId: 'd1', guildId: guildA, rotationId: 'r1', score: 500 });
    await insertScore(cycleId, { bbsId: 'bbs-bob', bbsName: 'Bob', userId: 'd2', guildId: guildA, rotationId: 'r1', score: 300 });
    return { cycleId };
  };

  it('uses the guild recorded on the scores for a past cycle', async () => {
    const { cycleId } = await seedTransfer([{ rotation_id: 'r1', position: 1, start_date: '01/01/2025', end_date: '03/01/2025' }]);

    const guildA = await getPodiumFull(db, { cycle_name: 'Cycle Scope', guild_name: 'Guilde A' });
    expect(guildA.data.map((p) => p.bbs_name)).toEqual(['Alice', 'Bob']);
    const guildB = await getPodiumFull(db, { cycle_name: 'Cycle Scope', guild_name: 'Guilde B' });
    expect(guildB.data).toEqual([]);

    const guildAId = (await db.collection('guildes').findOne({ name: 'Guilde A' }))._id.toString();
    const { podium } = await getPodium(db, { cycle_id: cycleId, guild_id: guildAId });
    expect(podium.map((p) => p.bbs_name)).toEqual(['Alice', 'Bob']);
  });

  it('uses the current guild members for the cycle in progress', async () => {
    const now = new Date();
    await seedTransfer([{ rotation_id: 'r1', position: 1, start_date: ddmmyyyy(new Date(now.getTime() - 2 * DAY)), end_date: ddmmyyyy(new Date(now.getTime() + 2 * DAY)) }]);

    const guildA = await getPodiumFull(db, { cycle_name: 'Cycle Scope', guild_name: 'Guilde A' });
    expect(guildA.data.map((p) => p.bbs_name)).toEqual(['Bob']);
    const guildB = await getPodiumFull(db, { cycle_name: 'Cycle Scope', guild_name: 'Guilde B' });
    expect(guildB.data.map((p) => p.bbs_name)).toEqual(['Alice']);
  });

  it('applies the same rule to the misses podium', async () => {
    await seedTransfer([{ rotation_id: 'r1', position: 1, start_date: '01/01/2025', end_date: '03/01/2025' }]);
    await db.collection('scores').updateMany({}, { $set: { score: 0 } });

    const guildA = await getPodiumMisses(db, { cycle_name: 'Cycle Scope', guild_name: 'Guilde A' });
    expect(guildA.data.map((p) => p.bbs_name).sort()).toEqual(['Alice', 'Bob']);
  });

  it('isCycleInProgress: from the first rotation start to the end of the last one', () => {
    const cycle = { rotations: [{ start_date: '01/03/2026' }, { start_date: '10/03/2026', end_date: '12/03/2026' }] };
    expect(isCycleInProgress(cycle, new Date(2026, 1, 28).getTime())).toBe(false);
    expect(isCycleInProgress(cycle, new Date(2026, 2, 1).getTime())).toBe(true);
    expect(isCycleInProgress(cycle, new Date(2026, 2, 12, 23).getTime())).toBe(true);
    expect(isCycleInProgress(cycle, new Date(2026, 2, 13, 1).getTime())).toBe(false);
    expect(isCycleInProgress({ rotations: [] })).toBe(false);
  });
});

// --- getDraftProposal --------------------------------------------------------

describe('getDraftProposal (integration)', () => {
  it('splits ranked candidates into chunks of 20 across the requested guild order', async () => {
    const guildA = await makeGuild('A');
    const guildB = await makeGuild('B');
    const cycle = await makeCycle({ name: 'Cycle Draft', rotations: [makeRotationMeta('r1', 1)] });
    const cycleId = cycle._id.toString();

    // 25 joueurs classés par score décroissant, tous actuellement dans Guilde A.
    const users = [];
    for (let i = 0; i < 25; i++) {
      const bbsId = `bbs-${i}`;
      users.push({ discord_id: `d${i}`, bbs_accounts: [{ bbs_id: bbsId, guilde_id: guildA }] });
      await insertScore(cycleId, { bbsId, bbsName: `Player${i}`, userId: `d${i}`, guildId: guildA, rotationId: 'r1', score: 1000 - i });
    }
    await db.collection('users').insertMany(users);

    const result = await getDraftProposal(db, { cycle_name: 'Cycle Draft', guild_names: 'A,B' });

    expect(result.guilds[0].guild_name).toBe('A');
    expect(result.guilds[0].players).toHaveLength(20);
    expect(result.guilds[1].guild_name).toBe('B');
    expect(result.guilds[1].players).toHaveLength(5);
    expect(result.leftover).toHaveLength(0);
    // Le meilleur score (Player0) doit être en tête de la première guilde.
    expect(result.guilds[0].players[0].bbs_name).toBe('Player0');
  });

  it('leaves a locked guild untouched and drafts the other guilds without it', async () => {
    const guildA = await makeGuild('A');
    const guildB = await makeGuild('B');
    const guildC = await makeGuild('C');
    const cycle = await makeCycle({ name: 'Cycle Lock', rotations: [makeRotationMeta('r1', 1)] });
    const cycleId = cycle._id.toString();

    // A : 2 très bons joueurs qu'on veut garder ensemble ; B et C : 25 joueurs à répartir
    const users = [
      { discord_id: 'a1', bbs_accounts: [{ bbs_id: 'bbs-a1', guilde_id: guildA }] },
      { discord_id: 'a2', bbs_accounts: [{ bbs_id: 'bbs-a2', guilde_id: guildA }] },
    ];
    await insertScore(cycleId, { bbsId: 'bbs-a1', bbsName: 'A1', userId: 'a1', guildId: guildA, rotationId: 'r1', score: 5000 });
    await insertScore(cycleId, { bbsId: 'bbs-a2', bbsName: 'A2', userId: 'a2', guildId: guildA, rotationId: 'r1', score: 4000 });
    for (let i = 0; i < 25; i++) {
      const guildId = i % 2 ? guildB : guildC;
      users.push({ discord_id: `d${i}`, bbs_accounts: [{ bbs_id: `bbs-${i}`, guilde_id: guildId }] });
      await insertScore(cycleId, { bbsId: `bbs-${i}`, bbsName: `P${i}`, userId: `d${i}`, guildId, rotationId: 'r1', score: 1000 - i });
    }
    await db.collection('users').insertMany(users);

    const result = await getDraftProposal(db, { cycle_name: 'Cycle Lock', guild_names: 'A,B,C', locked_guild_names: 'A' });

    expect(result.guilds.map((g) => [g.guild_name, !!g.locked, g.players.length])).toEqual([['A', true, 2], ['B', false, 20], ['C', false, 5]]);
    expect(result.guilds[0].players.map((p) => p.bbs_name)).toEqual(['A1', 'A2']);
    expect(result.guilds[0].players[0].overallRank).toBeNull();
    // Les joueurs de A ne sont pas redistribués : le 1er paquet de B commence par P0
    expect(result.guilds[1].players[0].bbs_name).toBe('P0');
    expect(result.meta.lockedGuilds).toEqual(['A']);
    expect(result.meta.totalCandidates).toBe(25);
  });

  it('keeps a pinned player in their current guild regardless of score', async () => {
    const guildA = await makeGuild('A');
    const guildB = await makeGuild('B');
    const cycle = await makeCycle({ name: 'Cycle Pin', rotations: [makeRotationMeta('r1', 1)] });
    const cycleId = cycle._id.toString();

    await db.collection('users').insertMany([
      { discord_id: 'd1', bbs_accounts: [{ bbs_id: 'bbs-low', guilde_id: guildA }] },
      { discord_id: 'd2', bbs_accounts: [{ bbs_id: 'bbs-high', guilde_id: guildB }] },
    ]);
    // bbs-low a un score très faible mais est épinglé sur Guilde A.
    await insertScore(cycleId, { bbsId: 'bbs-low', bbsName: 'Low', userId: 'd1', guildId: guildA, rotationId: 'r1', score: 1 });
    await insertScore(cycleId, { bbsId: 'bbs-high', bbsName: 'High', userId: 'd2', guildId: guildB, rotationId: 'r1', score: 999 });

    const result = await getDraftProposal(db, {
      cycle_name: 'Cycle Pin',
      guild_names: 'A,B',
      pinned_bbs_ids: 'bbs-low',
    });

    const guildAPlayers = result.guilds.find(g => g.guild_name === 'A').players.map(p => p.bbs_name);
    expect(guildAPlayers).toContain('Low');
  });

  it('excludes a player from the simulation entirely when excluded_bbs_ids is given', async () => {
    const guildA = await makeGuild('A');
    const cycle = await makeCycle({ name: 'Cycle Excl', rotations: [makeRotationMeta('r1', 1)] });
    const cycleId = cycle._id.toString();

    await db.collection('users').insertOne({ discord_id: 'd1', bbs_accounts: [{ bbs_id: 'bbs-1', guilde_id: guildA }] });
    await insertScore(cycleId, { bbsId: 'bbs-1', bbsName: 'Alice', userId: 'd1', guildId: guildA, rotationId: 'r1', score: 100 });

    const result = await getDraftProposal(db, {
      cycle_name: 'Cycle Excl',
      guild_names: 'A',
      excluded_bbs_ids: 'bbs-1',
    });

    expect(result.meta.totalCandidates).toBe(0);
    expect(result.guilds[0].players).toHaveLength(0);
  });

  it('throws a 404 when a requested guild name does not exist', async () => {
    await makeCycle({ name: 'Cycle NoGuild', rotations: [] });
    await expect(getDraftProposal(db, { cycle_name: 'Cycle NoGuild', guild_names: 'Ghost' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

// --- getDraftReplacement -------------------------------------------------------

describe('getDraftReplacement (integration)', () => {
  // Ordre A > C > B : on remplace des joueurs de C
  const seedHierarchy = async () => {
    const guilds = {};
    for (const name of ['A', 'C', 'B']) guilds[name] = await makeGuild(name);
    const cycle = await makeCycle({ name: 'Cycle Repl', rotations: [makeRotationMeta('r1', 1)] });
    const cycleId = cycle._id.toString();
    const players = [
      ['a-strong', 'A', 900], // plus fort, mais guilde supérieure : jamais proposé
      ['c-weak', 'C', 500], ['c-mid', 'C', 600], ['c-strong', 'C', 950], // c-strong : même guilde, jamais proposé
      ['b-top', 'B', 700], ['b-equal', 'B', 480], ['b-low', 'B', 300],
      ['free', null, 650], // sans guilde : proposable
    ];
    const users = [];
    for (const [bbsId, guildName, value] of players) {
      users.push({ discord_id: `d-${bbsId}`, bbs_accounts: [{ bbs_id: bbsId, guilde_id: guildName ? guilds[guildName] : null }] });
      await insertScore(cycleId, { bbsId, bbsName: bbsId, userId: `d-${bbsId}`, guildId: guildName ? guilds[guildName] : null, rotationId: 'r1', score: value });
    }
    await db.collection('users').insertMany(users);
  };

  it('lists the target guild roster when no player is selected', async () => {
    await seedHierarchy();
    const result = await getDraftReplacement(db, { cycle_name: 'Cycle Repl', guild_names: 'A,C,B', target_guild: 'C' });
    expect(result.roster.map((p) => p.bbs_id)).toEqual(['c-strong', 'c-mid', 'c-weak']);
    expect(result.replacements).toEqual([]);
    expect(result.meta).toMatchObject({ higherGuilds: ['A'], lowerGuilds: ['B'] });
  });

  it('only suggests equivalent or stronger players from lower guilds or without guild', async () => {
    await seedHierarchy();
    const result = await getDraftReplacement(db, {
      cycle_name: 'Cycle Repl', guild_names: 'A,C,B', target_guild: 'C', replace_bbs_ids: 'c-weak,c-mid', tolerance: 5,
    });

    const byPlayer = Object.fromEntries(result.replacements.map((r) => [r.player.bbs_id, r]));
    // c-weak (500) : ≥ 475 → b-top 700, free 650, b-equal 480 ; jamais a-strong ni c-strong
    expect(byPlayer['c-weak'].suggestions.map((c) => c.bbs_id)).toEqual(['b-top', 'free', 'b-equal']);
    // c-mid (600) : ≥ 570 → b-top, free
    expect(byPlayer['c-mid'].suggestions.map((c) => c.bbs_id)).toEqual(['b-top', 'free']);
    expect(byPlayer['c-mid'].suggestions[0]).toMatchObject({ currentGuildName: 'B', delta: 100, deltaPercent: 16.7 });
    expect(byPlayer['c-mid'].suggestions[1].currentGuildName).toBeNull();
    // Recommandation : le plus fort (c-mid) prend b-top, c-weak prend le suivant libre (free)
    expect(byPlayer['c-mid'].recommended_bbs_id).toBe('b-top');
    expect(byPlayer['c-weak'].recommended_bbs_id).toBe('free');
  });

  it('with no tolerance, only stronger players are suggested', async () => {
    await seedHierarchy();
    const result = await getDraftReplacement(db, {
      cycle_name: 'Cycle Repl', guild_names: 'A,C,B', target_guild: 'C', replace_bbs_ids: 'c-weak', tolerance: 0,
    });
    expect(result.replacements[0].suggestions.map((c) => c.bbs_id)).toEqual(['b-top', 'free']);
  });

  it('rejects a target guild outside the order and an invalid tolerance', async () => {
    await seedHierarchy();
    await expect(getDraftReplacement(db, { cycle_name: 'Cycle Repl', guild_names: 'A,C,B', target_guild: 'Z' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(getDraftReplacement(db, { cycle_name: 'Cycle Repl', guild_names: 'A,C,B', target_guild: 'C', tolerance: 80 })).rejects.toMatchObject({ statusCode: 400 });
  });
});

