/**
 * Monthly guild raffle: settings, tickets entered by leaders, ticket counts and the draw.
 * Months are game months (podiumService/gameMonths.js), one draw per guild and per month.
 */
import crypto from 'crypto';
import { ObjectId } from 'mongodb';
import { getGameMonths } from '../podiumService/gameMonths.js';
import { parseDate } from '../killerRecords.js';
import { sendDiscordMessage } from '../../utils/botClient.js';
import { logger } from '../../utils/logger.js';
import { computeRaffleTickets, pickWinner, RAFFLE_RULES } from './computeTickets.js';

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DEFAULT_SETTINGS = { guild_ids: [], prize: 'Pack perso (25 €)', max_tickets: 20 };

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

export const getRaffleSettings = async (db) => {
  const stored = await db.collection('app_settings').findOne({ _id: 'raffle' });
  return {
    guild_ids: Array.isArray(stored?.guild_ids) ? stored.guild_ids : DEFAULT_SETTINGS.guild_ids,
    prize: typeof stored?.prize === 'string' ? stored.prize : DEFAULT_SETTINGS.prize,
    max_tickets: Number.isInteger(stored?.max_tickets) ? stored.max_tickets : DEFAULT_SETTINGS.max_tickets,
  };
};

export const saveRaffleSettings = async (db, body) => {
  const update = {};
  if (body.guild_ids !== undefined) {
    if (!Array.isArray(body.guild_ids) || !body.guild_ids.every((id) => ObjectId.isValid(id))) {
      throw httpError(400, 'guild_ids doit être une liste d\'ID de guildes');
    }
    update.guild_ids = [...new Set(body.guild_ids.map(String))];
  }
  if (body.prize !== undefined) update.prize = String(body.prize).trim().slice(0, 120);
  if (body.max_tickets !== undefined) {
    const max = parseInt(body.max_tickets, 10);
    if (!Number.isInteger(max) || max < 1 || max > 1000) throw httpError(400, 'max_tickets doit être entre 1 et 1000');
    update.max_tickets = max;
  }
  await db.collection('app_settings').updateOne({ _id: 'raffle' }, { $set: update }, { upsert: true });
  return getRaffleSettings(db);
};

const loadCycles = (db) => db.collection('cycles').find({}, { projection: { rotations: 1 } }).toArray();

export const getRaffleMonths = async (db) => {
  const months = getGameMonths(await loadCycles(db));
  return months.map(({ key, start_date, end_date, in_progress, finished }) => ({ key, start_date, end_date, in_progress, finished }));
};

const findMonth = (cycles, monthKey) => {
  if (!MONTH_KEY.test(monthKey ?? '')) throw httpError(400, 'Le mois doit être au format AAAA-MM');
  const month = getGameMonths(cycles).find((m) => m.key === monthKey);
  if (!month) throw httpError(404, `Aucune semaine de guilde en ${monthKey}`);
  return month;
};

const assertRaffleGuild = async (db, guildId) => {
  const settings = await getRaffleSettings(db);
  if (!settings.guild_ids.includes(guildId)) throw httpError(404, 'Cette guilde ne participe pas à la tombola');
  const guild = ObjectId.isValid(guildId)
    ? await db.collection('guildes').findOne({ _id: new ObjectId(guildId) }, { projection: { name: 1, discord_general_channel_id: 1 } })
    : null;
  if (!guild) throw httpError(404, 'Guilde non trouvée');
  return { settings, guild };
};

const monthDocId = (monthKey, guildId) => `${monthKey}:${guildId}`;

// Earliest known presence of each account in the guilds: first scored rotation, join date, or the
// arrival date entered by a leader (scores only go back to September 2025)
const loadFirstSeen = async (db, cycles, bbsIds) => {
  const rotationStart = new Map();
  for (const cycle of cycles) {
    for (const r of cycle.rotations || []) rotationStart.set(`${cycle._id}|${r.rotation_id}`, parseDate(r.start_date));
  }
  const [scores, users, members] = await Promise.all([
    db.collection('scores').find({ bbs_id: { $in: bbsIds } }, { projection: { bbs_id: 1, cycle_id: 1, rotation_id: 1 } }).toArray(),
    db.collection('users').find({ 'bbs_accounts.bbs_id': { $in: bbsIds } }, { projection: { bbs_accounts: 1 } }).toArray(),
    db.collection('raffle_members').find({ _id: { $in: bbsIds } }).toArray(),
  ]);
  const firstSeen = new Map();
  const keep = (bbsId, ts) => {
    if (!ts) return;
    if (!firstSeen.has(bbsId) || ts < firstSeen.get(bbsId)) firstSeen.set(bbsId, ts);
  };
  for (const s of scores) keep(s.bbs_id, rotationStart.get(`${s.cycle_id}|${s.rotation_id}`));
  for (const u of users) {
    for (const a of u.bbs_accounts || []) {
      if (bbsIds.includes(a.bbs_id) && a.guild_joined_at) keep(a.bbs_id, new Date(a.guild_joined_at).getTime());
    }
  }
  for (const m of members) if (m.schrift_since) keep(m._id, new Date(m.schrift_since).getTime());
  return { firstSeen, declared: new Map(members.map((m) => [m._id, m.schrift_since])) };
};

const loadIdentities = async (db, bbsIds) => {
  const users = await db.collection('users').find(
    { 'bbs_accounts.bbs_id': { $in: bbsIds } },
    { projection: { discord_id: 1, avatar: 1, global_name: 1, 'bbs_accounts.bbs_id': 1 } }
  ).toArray();
  const byBbsId = new Map();
  for (const u of users) for (const a of u.bbs_accounts || []) byBbsId.set(a.bbs_id, u);
  return byBbsId;
};

// Months saved before the rank field had a yes/no S rank switch worth 1 ticket
const rankTicketsOf = (monthDoc) => (Number.isInteger(monthDoc?.rank_tickets) ? monthDoc.rank_tickets : monthDoc?.s_rank === true ? 1 : 0);

// The guild's rank of the month, or the last one entered before it, S by default
const guildRankAt = async (db, monthKey, guildId) => {
  const doc = await db.collection('raffle_months').findOne(
    { guild_id: guildId, month: { $lte: monthKey }, rank: { $in: RAFFLE_RULES.ranks } },
    { sort: { month: -1 }, projection: { rank: 1 } }
  );
  return doc?.rank ?? RAFFLE_RULES.ranks[0];
};

export const getGuildRaffle = async (db, { month: monthKey, guildId }) => {
  const { settings, guild } = await assertRaffleGuild(db, guildId);
  const cycles = await loadCycles(db);
  const month = findMonth(cycles, monthKey);

  const rotationsByCycle = new Map();
  for (const { cycle_id, rotation_id } of month.rotations) {
    rotationsByCycle.set(cycle_id, [...(rotationsByCycle.get(cycle_id) ?? []), rotation_id]);
  }
  const [scores, manual, monthDoc, members, rank] = await Promise.all([
    db.collection('scores').find(
      { guild_id: guildId, $or: [...rotationsByCycle].map(([cycleId, ids]) => ({ cycle_id: cycleId, rotation_id: { $in: ids } })) },
      { projection: { bbs_id: 1, bbs_name: 1, cycle_id: 1, rotation_id: 1, score: 1 } }
    ).toArray(),
    db.collection('raffle_tickets').find({ month: month.key, guild_id: guildId }).toArray(),
    db.collection('raffle_months').findOne({ _id: monthDocId(month.key, guildId) }),
    // Current members only matter while the month is open: a finished month keeps the players who scored
    month.finished ? [] : db.collection('users').find(
      { 'bbs_accounts.guilde_id': guildId, is_banned: { $ne: true } },
      { projection: { bbs_accounts: 1 } }
    ).toArray(),
    guildRankAt(db, month.key, guildId),
  ]);

  const players = [
    ...members.flatMap((u) => (u.bbs_accounts || []).filter((a) => a.guilde_id === guildId && a.bbs_id)),
    ...manual.map((m) => ({ bbs_id: m.bbs_id, bbs_name: m.bbs_name })),
  ];
  const bbsIds = [...new Set([...scores.map((s) => s.bbs_id), ...players.map((p) => p.bbs_id)].filter(Boolean))];
  const [{ firstSeen, declared }, identities] = await Promise.all([loadFirstSeen(db, cycles, bbsIds), loadIdentities(db, bbsIds)]);

  const result = computeRaffleTickets({
    rotations: month.rotations,
    scores,
    players,
    firstSeen,
    manual,
    rankTickets: rankTicketsOf(monthDoc),
    monthEnd: month.ends_at,
    maxTickets: settings.max_tickets,
  });

  return {
    month: { key: month.key, start_date: month.start_date, end_date: month.end_date, in_progress: month.in_progress, finished: month.finished },
    guild: { _id: guildId, name: guild.name },
    prize: settings.prize,
    max_tickets: settings.max_tickets,
    rules: RAFFLE_RULES,
    rank,
    rank_tickets: rankTicketsOf(monthDoc),
    draw: monthDoc?.draw ?? null,
    ...result,
    players: result.players.map((p) => {
      const user = identities.get(p.bbs_id);
      return {
        ...p,
        discord_id: user?.discord_id ?? null,
        avatar: user?.avatar ?? null,
        global_name: user?.global_name ?? null,
        first_seen: firstSeen.has(p.bbs_id) ? new Date(firstSeen.get(p.bbs_id)).toISOString() : null,
        schrift_since: declared.get(p.bbs_id) ?? null,
      };
    }),
  };
};

// The token only carries the Discord id: the name shown in the history is read from the account
const author = async (db, user) => {
  const discordId = user?.discord_id ?? null;
  const account = discordId
    ? await db.collection('users').findOne({ discord_id: discordId }, { projection: { global_name: 1, username: 1 } })
    : null;
  return { discord_id: discordId, name: account?.global_name || account?.username || user?.global_name || user?.username || null };
};

const assertNotDrawn = async (db, monthKey, guildId) => {
  const doc = await db.collection('raffle_months').findOne({ _id: monthDocId(monthKey, guildId) }, { projection: { draw: 1 } });
  if (doc?.draw) throw httpError(409, 'Le tirage de ce mois est déjà fait : les tickets ne peuvent plus changer');
};

// Rank the guild aims to reach or keep, and the tickets every member earned for it this month
export const setGuildRank = async (db, { month, guildId, rank, tickets, user }) => {
  if (!RAFFLE_RULES.ranks.includes(rank)) throw httpError(400, `Le rang doit être ${RAFFLE_RULES.ranks.join(', ')}`);
  if (!Number.isInteger(tickets) || tickets < 0 || tickets > RAFFLE_RULES.maxRankTickets) {
    throw httpError(400, `Le nombre de tickets de rang doit être entre 0 et ${RAFFLE_RULES.maxRankTickets}`);
  }
  await assertRaffleGuild(db, guildId);
  findMonth(await loadCycles(db), month);
  await assertNotDrawn(db, month, guildId);
  await db.collection('raffle_months').updateOne(
    { _id: monthDocId(month, guildId) },
    {
      $set: { month, guild_id: guildId, rank, rank_tickets: tickets, rank_updated_by: await author(db, user), updated_at: new Date() },
      $unset: { s_rank: '', s_rank_updated_by: '' },
    },
    { upsert: true }
  );
};

// Farm / QG tickets: one checkbox per player and per half-month (period 1 or 2)
export const setGuildLifeTicket = async (db, { month, guildId, bbsId, bbsName, kind, period, checked, user }) => {
  if (!['farm', 'qg'].includes(kind)) throw httpError(400, 'kind doit être "farm" ou "qg"');
  if (![1, 2].includes(period)) throw httpError(400, 'period doit être 1 ou 2');
  await assertRaffleGuild(db, guildId);
  findMonth(await loadCycles(db), month);
  await assertNotDrawn(db, month, guildId);

  const key = { month, guild_id: guildId, bbs_id: String(bbsId), kind, period };
  if (checked) {
    await db.collection('raffle_tickets').updateOne(
      key,
      { $set: { ...key, bbs_name: bbsName ?? null, count: 1, created_by: await author(db, user), created_at: new Date() } },
      { upsert: true }
    );
  } else {
    await db.collection('raffle_tickets').deleteOne(key);
  }
};

// Arrival date in Schrift ('YYYY-MM', or null to clear) for the seniority tickets
export const setSchriftSince = async (db, { guildId, bbsId, since, user }) => {
  await assertRaffleGuild(db, guildId);
  if (since === null || since === '') {
    await db.collection('raffle_members').deleteOne({ _id: String(bbsId) });
    return;
  }
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(since));
  if (!match) throw httpError(400, 'La date d\'arrivée doit être au format AAAA-MM');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  if (date.getTime() > Date.now()) throw httpError(400, 'La date d\'arrivée ne peut pas être dans le futur');
  await db.collection('raffle_members').updateOne(
    { _id: String(bbsId) },
    { $set: { schrift_since: date, updated_by: await author(db, user), updated_at: new Date() } },
    { upsert: true }
  );
};

// One-off activities: free label and ticket count
export const addBonusTicket = async (db, { month, guildId, bbsId, bbsName, label, count, user }) => {
  const tickets = parseInt(count, 10);
  if (!Number.isInteger(tickets) || tickets < 1 || tickets > 20) throw httpError(400, 'Le nombre de tickets doit être entre 1 et 20');
  const text = String(label ?? '').trim().slice(0, 80);
  if (!text) throw httpError(400, 'Indique l\'activité');
  await assertRaffleGuild(db, guildId);
  findMonth(await loadCycles(db), month);
  await assertNotDrawn(db, month, guildId);

  await db.collection('raffle_tickets').insertOne({
    month, guild_id: guildId, bbs_id: String(bbsId), bbs_name: bbsName ?? null, kind: 'bonus', period: null,
    label: text, count: tickets, created_by: await author(db, user), created_at: new Date(),
  });
};

export const removeBonusTicket = async (db, { month, guildId, ticketId }) => {
  if (!ObjectId.isValid(ticketId)) throw httpError(400, 'ID de ticket invalide');
  await assertRaffleGuild(db, guildId);
  await assertNotDrawn(db, month, guildId);
  const res = await db.collection('raffle_tickets').deleteOne({ _id: new ObjectId(ticketId), month, guild_id: guildId, kind: 'bonus' });
  if (res.deletedCount === 0) throw httpError(404, 'Ticket non trouvé');
};

const announce = async (guild, raffle, winner) => {
  if (!guild.discord_general_channel_id) return 'no_channel';
  const label = new Date(`${raffle.month.key}-01T12:00:00Z`).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const content = [
    `🎟️ **Tombola de ${label}** · guilde ${guild.name}`,
    `${raffle.total_tickets} tickets en jeu entre ${raffle.players.filter((p) => p.tickets > 0).length} joueurs.`,
    `🏆 Le gagnant du **${raffle.prize}** est **${winner.bbs_name}**${winner.discord_id ? ` (<@${winner.discord_id}>)` : ''} avec ${winner.tickets} ticket${winner.tickets > 1 ? 's' : ''} !`,
  ].join('\n');
  try {
    await sendDiscordMessage({
      channel_id: guild.discord_general_channel_id,
      content,
      mention_user_ids: winner.discord_id ? [winner.discord_id] : [],
    });
    return 'sent';
  } catch (err) {
    logger.warn('[raffle] Annonce Discord impossible:', err.message);
    return 'failed';
  }
};

// Draws the winner of a finished month once; the tickets are frozen in the draw for transparency
export const drawGuildRaffle = async (db, { month, guildId, user, announceOnDiscord = true }) => {
  const { guild } = await assertRaffleGuild(db, guildId);
  const raffle = await getGuildRaffle(db, { month, guildId });
  if (!raffle.month.finished) throw httpError(409, 'Le mois n\'est pas terminé');
  if (raffle.draw) throw httpError(409, 'Le tirage de ce mois est déjà fait');
  const entrants = raffle.players.filter((p) => p.tickets > 0);
  const total = entrants.reduce((sum, p) => sum + p.tickets, 0);
  if (total === 0) throw httpError(409, 'Aucun ticket en jeu');

  const pick = crypto.randomInt(total);
  const winner = pickWinner(entrants, pick);
  const draw = {
    winner: { bbs_id: winner.bbs_id, bbs_name: winner.bbs_name, discord_id: winner.discord_id, tickets: winner.tickets },
    ticket_number: pick + 1,
    total_tickets: total,
    prize: raffle.prize,
    entrants: entrants.map((p) => ({ bbs_id: p.bbs_id, bbs_name: p.bbs_name, tickets: p.tickets })),
    drawn_at: new Date(),
    drawn_by: await author(db, user),
  };

  // The filter refuses a second concurrent draw
  const res = await db.collection('raffle_months').updateOne(
    { _id: monthDocId(month, guildId), draw: null },
    { $set: { month, guild_id: guildId, draw } },
    { upsert: true }
  ).catch((err) => {
    if (err.code === 11000) throw httpError(409, 'Le tirage de ce mois est déjà fait');
    throw err;
  });
  if (res.matchedCount === 0 && res.upsertedCount === 0) throw httpError(409, 'Le tirage de ce mois est déjà fait');

  const announcement = announceOnDiscord ? await announce(guild, raffle, winner) : 'skipped';
  return { draw, announcement };
};

// Admin only: cancels a draw (wrong tickets, test...) so it can be done again
export const cancelGuildDraw = async (db, { month, guildId }) => {
  await db.collection('raffle_months').updateOne({ _id: monthDocId(month, guildId) }, { $set: { draw: null } });
};
