import { ObjectId } from 'mongodb';
import { loadComparableScores, parseDate, toObjectIds, cycleTimestamp } from './killerRecords.js';
import { getCyclesChronological } from './playerTrends.js';
import { isCycleInProgress } from './podiumService/index.js';
import { getGuildAccountRoster } from '../utils/bbsAccounts.js';

/**
 * Leader tools for their guild (CURRENT members, those a leader can enter scores for): missing
 * scores of a cycle and rotation preparation sheet.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const rotationEnd = (r) => parseDate(r.end_date) || parseDate(r.start_date);

// A member only owes scores for rotations that ended after they joined the guild. An unknown join
// date (assignments made before it was recorded) counts as always having been there.
const wasMemberDuring = (member, rotation) =>
  !member.guild_joined_at || rotationEnd(rotation) + DAY_MS > new Date(member.guild_joined_at).getTime();

/** The requested cycle, otherwise the current one, otherwise the latest started cycle. */
export const resolveCycle = async (db, cycleId, now = Date.now()) => {
  if (cycleId) {
    if (!ObjectId.isValid(cycleId)) return null;
    return db.collection('cycles').findOne({ _id: new ObjectId(cycleId) });
  }
  const started = (await getCyclesChronological(db)).filter((c) => c.rotations?.length && cycleTimestamp(c) <= now);
  return started.find((c) => isCycleInProgress(c, now)) || started[started.length - 1] || null;
};

const rotationDocs = async (db, rotationIds) => {
  const docs = await db.collection('rotations')
    .find({ _id: { $in: toObjectIds(rotationIds) } }, { projection: { killer: 1, attack: 1, alteration: 1 } })
    .toArray();
  return new Map(docs.map((r) => [r._id.toString(), r]));
};

/**
 * Missing scores: for each finished rotation of the cycle, the guild's current members without any
 * score (whatever the score's guild). Most recent rotations first.
 */
export const getMissingScores = async (db, { guildId, cycleId, now = Date.now() }) => {
  const cycle = await resolveCycle(db, cycleId, now);
  if (!cycle) return { cycle: null, members_count: 0, rotations: [] };

  const roster = await getGuildAccountRoster(db, guildId);
  const bbsIds = roster.map((m) => m.bbs_id).filter(Boolean);
  const cycleIdStr = cycle._id.toString();

  const scored = new Set((await db.collection('scores').find(
    { cycle_id: cycleIdStr, bbs_id: { $in: bbsIds } },
    { projection: { bbs_id: 1, rotation_id: 1 } }
  ).toArray()).map((s) => `${s.bbs_id}|${s.rotation_id}`));

  const ended = (cycle.rotations || [])
    .map((r, index) => ({ ...r, index }))
    .filter((r) => rotationEnd(r) + DAY_MS <= now);
  const rotationById = await rotationDocs(db, ended.map((r) => r.rotation_id));

  const rotations = ended.map((r) => {
    const doc = rotationById.get(r.rotation_id);
    return {
      rotation_id: r.rotation_id,
      position: r.position ?? r.index + 1,
      start_date: r.start_date || null,
      end_date: r.end_date || null,
      killer: doc?.killer || r.killer || null,
      attack: doc?.attack || r.attack || null,
      alteration: doc?.alteration || r.alteration || null,
      // Differential rotation (2nd of the week): the leader enters the running total shown in game
      is_differential: r.index % 2 === 1,
      missing: roster
        .filter((m) => m.bbs_id && wasMemberDuring(m, r) && !scored.has(`${m.bbs_id}|${r.rotation_id}`))
        .map((m) => ({ user_id: m.user_id, bbs_id: m.bbs_id, bbs_name: m.bbs_name || null, global_name: m.global_name || null }))
        .sort((a, b) => (a.bbs_name || '').localeCompare(b.bbs_name || '')),
    };
  }).reverse();

  return {
    cycle: { _id: cycleIdStr, name: cycle.name, year: cycle.year },
    members_count: bbsIds.length,
    rotations,
  };
};

/**
 * Records that an account joined the guild after a rotation (set by a leader when the join date is
 * unknown), so that rotation and the earlier ones no longer count as missing. Returns the new date,
 * or null when the account or rotation is not found.
 */
export const markJoinedAfterRotation = async (db, { guildId, bbsId, cycleId, rotationId }) => {
  const cycle = await resolveCycle(db, cycleId);
  const rotation = cycle?.rotations?.find((r) => r.rotation_id === rotationId);
  if (!rotation) return null;

  const joinedAt = new Date(rotationEnd(rotation) + DAY_MS);
  const { matchedCount } = await db.collection('users').updateOne(
    { bbs_accounts: { $elemMatch: { bbs_id: bbsId, guilde_id: guildId } } },
    { $set: { 'bbs_accounts.$[account].guild_joined_at': joinedAt } },
    { arrayFilters: [{ 'account.bbs_id': bbsId }] }
  );
  return matchedCount ? joinedAt : null;
};

const round = (n) => Math.round(n);

/**
 * Rotation preparation sheet: each current guild member's history on this killer (record, average,
 * latest score), plus the average and record of all players.
 * Default rotation: the next unfinished rotation of the cycle (otherwise the last one).
 */
export const getRotationPreparation = async (db, { guildId, cycleId, rotationId, now = Date.now() }) => {
  const cycle = await resolveCycle(db, cycleId, now);
  if (!cycle) return null;
  const rotations = cycle.rotations || [];
  const meta = rotationId
    ? rotations.find((r) => r.rotation_id === rotationId)
    : rotations.find((r) => rotationEnd(r) + DAY_MS > now) || rotations[rotations.length - 1];
  if (!meta) return null;

  const roster = await getGuildAccountRoster(db, guildId);
  const [comparable, cycles, rotationById] = await Promise.all([
    loadComparableScores(db, { rotation_id: meta.rotation_id }),
    getCyclesChronological(db),
    rotationDocs(db, [meta.rotation_id]),
  ]);
  const order = new Map(cycles.map((c, i) => [c._id.toString(), i]));
  const cycleById = new Map(cycles.map((c) => [c._id.toString(), c]));
  const byAccount = new Map();
  for (const s of comparable) {
    if (!byAccount.has(s.bbs_id)) byAccount.set(s.bbs_id, []);
    byAccount.get(s.bbs_id).push(s);
  }

  const allValues = comparable.map((s) => s.score || 0);
  const cycleIdStr = cycle._id.toString();
  const members = roster.filter((m) => m.bbs_id).map((m) => {
    const history = (byAccount.get(m.bbs_id) || []).sort((a, b) => (order.get(a.cycle_id) ?? 0) - (order.get(b.cycle_id) ?? 0));
    const values = history.map((s) => s.score || 0);
    const last = history[history.length - 1];
    const current = history.find((s) => s.cycle_id === cycleIdStr);
    return {
      user_id: m.user_id,
      bbs_id: m.bbs_id,
      bbs_name: m.bbs_name || null,
      global_name: m.global_name || null,
      attempts: values.length,
      best: values.length ? Math.max(...values) : null,
      average: values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null,
      last: last ? { score: last.score || 0, cycle_name: cycleById.get(last.cycle_id)?.name || null, cycle_year: cycleById.get(last.cycle_id)?.year || null } : null,
      this_cycle: current ? current.score || 0 : null,
    };
  }).sort((a, b) => (b.average ?? -1) - (a.average ?? -1) || (a.bbs_name || '').localeCompare(b.bbs_name || ''));

  const doc = rotationById.get(meta.rotation_id);
  return {
    cycle: { _id: cycleIdStr, name: cycle.name, year: cycle.year },
    rotation: {
      rotation_id: meta.rotation_id,
      position: meta.position ?? rotations.indexOf(meta) + 1,
      start_date: meta.start_date || null,
      end_date: meta.end_date || null,
      killer: doc?.killer || meta.killer || null,
      attack: doc?.attack || meta.attack || null,
      alteration: doc?.alteration || meta.alteration || null,
    },
    killer_stats: {
      attempts: allValues.length,
      average: allValues.length ? round(allValues.reduce((a, b) => a + b, 0) / allValues.length) : null,
      record: allValues.length ? Math.max(...allValues) : null,
    },
    members,
  };
};
