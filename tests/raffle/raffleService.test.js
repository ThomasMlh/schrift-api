import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import {
  addBonusTicket, cancelGuildDraw, drawGuildRaffle, getGuildRaffle, saveRaffleSettings, setGuildLifeTicket, setGuildRank, setSchriftSince,
} from '../../src/services/raffle/index.js';

jest.setTimeout(60000);

let mongod;
let client;
let db;
let guildId;
let otherGuildId;
const user = { discord_id: 'chef', global_name: 'Chef' };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');

  guildId = (await db.collection('guildes').insertOne({ name: 'A' })).insertedId.toString();
  otherGuildId = (await db.collection('guildes').insertOne({ name: 'B' })).insertedId.toString();
  await saveRaffleSettings(db, { guild_ids: [guildId] });

  // Two finished game weeks of September 2026 and one of October (stored start dates are one day late)
  const cycleId = (await db.collection('cycles').insertOne({
    name: 'C', year: 2026, rotations: [
      { rotation_id: 'r1', position: 1, start_date: '08/09/2026', end_date: '10/09/2026' },
      { rotation_id: 'r2', position: 2, start_date: '15/09/2026', end_date: '17/09/2026' },
      { rotation_id: 'r3', position: 3, start_date: '06/10/2026', end_date: '08/10/2026' },
    ],
  })).insertedId.toString();
  await db.collection('scores').insertMany(['r1', 'r2'].flatMap((rotation_id) => [
    { bbs_id: '1', bbs_name: 'Ichigo', cycle_id: cycleId, rotation_id, guild_id: guildId, score: 620_000_000 },
    { bbs_id: '2', bbs_name: 'Rukia', cycle_id: cycleId, rotation_id, guild_id: guildId, score: 619_900_000 },
  ]));
  await db.collection('users').insertOne({ discord_id: '42', bbs_accounts: [{ bbs_id: '1', bbs_name: 'Ichigo', guilde_id: guildId }] });
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

describe('raffle service', () => {
  it('only serves the guilds taking part', async () => {
    await expect(getGuildRaffle(db, { month: '2026-09', guildId: otherGuildId })).rejects.toMatchObject({ statusCode: 404 });
    await expect(getGuildRaffle(db, { month: '2026-13', guildId })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('adds the leaders\' tickets to the computed ones', async () => {
    await setGuildRank(db, { month: '2026-09', guildId, rank: 'A1', tickets: 3, user });
    await setGuildLifeTicket(db, { month: '2026-09', guildId, bbsId: '2', bbsName: 'Rukia', kind: 'farm', period: 1, checked: true, user });
    // Checking the same box twice keeps one ticket
    await setGuildLifeTicket(db, { month: '2026-09', guildId, bbsId: '2', bbsName: 'Rukia', kind: 'farm', period: 1, checked: true, user });
    await addBonusTicket(db, { month: '2026-09', guildId, bbsId: '2', bbsName: 'Rukia', label: 'Quiz', count: 2, user });
    await expect(addBonusTicket(db, { month: '2026-09', guildId, bbsId: '2', label: '', count: 2, user })).rejects.toMatchObject({ statusCode: 400 });

    const raffle = await getGuildRaffle(db, { month: '2026-09', guildId });
    const rukia = raffle.players.find((p) => p.bbs_id === '2');
    expect(raffle).toMatchObject({ rank: 'A1', rank_tickets: 3 });
    expect(rukia.breakdown).toMatchObject({ top5_rotations: 2, top5_month: 1, rank: 3, collective_gap: 1, farm: 1, bonus: 2 });
    expect(rukia.bonuses[0]).toMatchObject({ label: 'Quiz', count: 2 });
    expect(raffle.players.find((p) => p.bbs_id === '1').discord_id).toBe('42');
  });

  it('checks the rank and its tickets, and keeps the rank for the next months', async () => {
    await expect(setGuildRank(db, { month: '2026-09', guildId, rank: 'B', tickets: 1, user })).rejects.toMatchObject({ statusCode: 400 });
    await expect(setGuildRank(db, { month: '2026-09', guildId, rank: 'S', tickets: 5, user })).rejects.toMatchObject({ statusCode: 400 });
    await expect(setGuildRank(db, { month: '2026-09', guildId, rank: 'S', tickets: 1.5, user })).rejects.toMatchObject({ statusCode: 400 });
    await setGuildRank(db, { month: '2026-09', guildId, rank: 'A2', tickets: 4, user });
    const next = await getGuildRaffle(db, { month: '2026-10', guildId });
    expect(next).toMatchObject({ rank: 'A2', rank_tickets: 0 });
  });

  it('reads the former S rank switch as one ticket', async () => {
    await db.collection('raffle_months').updateOne({ _id: `2026-10:${guildId}` }, { $set: { month: '2026-10', guild_id: guildId, s_rank: true } }, { upsert: true });
    const raffle = await getGuildRaffle(db, { month: '2026-10', guildId });
    expect(raffle.rank_tickets).toBe(1);
    expect(raffle.players.every((p) => p.breakdown.rank === 1)).toBe(true);
  });

  it('uses the arrival date entered by a leader for seniority', async () => {
    await expect(setSchriftSince(db, { guildId, bbsId: '1', since: '2023-13', user })).rejects.toMatchObject({ statusCode: 400 });
    await setSchriftSince(db, { guildId, bbsId: '1', since: '2023-01', user });
    const ichigo = (await getGuildRaffle(db, { month: '2026-09', guildId })).players.find((p) => p.bbs_id === '1');
    expect(ichigo.years).toBe(3);
    expect(ichigo.breakdown.seniority).toBe(3);
    expect(ichigo.schrift_since).toEqual(new Date(Date.UTC(2023, 0, 1)));
  });

  it('draws once, freezes the tickets, and can be cancelled', async () => {
    const { draw, announcement } = await drawGuildRaffle(db, { month: '2026-09', guildId, user, announceOnDiscord: false });
    expect(announcement).toBe('skipped');
    expect(['1', '2']).toContain(draw.winner.bbs_id);
    expect(draw.total_tickets).toBe(draw.entrants.reduce((sum, p) => sum + p.tickets, 0));
    expect(draw.ticket_number).toBeGreaterThanOrEqual(1);

    await expect(drawGuildRaffle(db, { month: '2026-09', guildId, user, announceOnDiscord: false })).rejects.toMatchObject({ statusCode: 409 });
    await expect(addBonusTicket(db, { month: '2026-09', guildId, bbsId: '1', label: 'Late', count: 1, user })).rejects.toMatchObject({ statusCode: 409 });

    await cancelGuildDraw(db, { month: '2026-09', guildId });
    expect((await getGuildRaffle(db, { month: '2026-09', guildId })).draw).toBeNull();
  });
});
