import { parseDate } from './killerRecords.js';
import { MAX_PLAUSIBLE_SCORE } from './achievements.js';
import { getMinScoresForRanking } from './podiumService/helpers.js';
import { INDEXES } from './dbIndexes.js';

/**
 * Data checks for the admin "Data health" tab: everything that skews rankings or breaks a page.
 * Each check returns { code, severity, count, samples } and is skipped (count 0) when clean.
 * Severities: error (wrong numbers on the site), warning (to fix soon), info (worth a look).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SAMPLES = 10;

const check = (code, severity, items) => ({ code, severity, count: items.length, samples: items.slice(0, MAX_SAMPLES) });

// A text index is stored under the _fts key, whatever its fields
const hasIndex = (existing, key) => (Object.values(key).includes('text')
  ? existing.some((i) => i.key._fts === 'text')
  : existing.some((i) => JSON.stringify(i.key) === JSON.stringify(key)));

export const getDataHealth = async (db, { now = Date.now() } = {}) => {
  const [scores, users, cycles, rotations, guilds, minScores] = await Promise.all([
    db.collection('scores').find({}, { projection: { bbs_id: 1, bbs_name: 1, cycle_id: 1, rotation_id: 1, guild_id: 1, score: 1 } }).toArray(),
    db.collection('users').find({}, { projection: { bbs_accounts: 1, is_banned: 1, global_name: 1, username: 1 } }).toArray(),
    db.collection('cycles').find({}, { projection: { name: 1, year: 1, rotations: 1 } }).toArray(),
    db.collection('rotations').find({}, { projection: { _id: 1 } }).toArray(),
    db.collection('guildes').find({}, { projection: { name: 1, disabled: 1 } }).toArray(),
    getMinScoresForRanking(db),
  ]);

  const cycleById = new Map(cycles.map((c) => [c._id.toString(), c]));
  const cycleLabel = (cycleId) => {
    const cycle = cycleById.get(cycleId);
    return cycle ? `${cycle.name} ${cycle.year ?? ''}`.trim() : cycleId;
  };
  const positionOf = (cycleId, rotationId) => cycleById.get(cycleId)?.rotations?.find((r) => r.rotation_id === rotationId)?.position ?? null;
  const scoreSample = (s) => ({
    bbs_name: s.bbs_name ?? null, cycle: cycleLabel(s.cycle_id), position: positionOf(s.cycle_id, s.rotation_id), score: s.score ?? null,
  });

  const accounts = users.flatMap((u) => (u.bbs_accounts || []).map((a) => ({ ...a, user: u })));
  const knownBbsIds = new Set(accounts.map((a) => a.bbs_id).filter(Boolean));
  const knownRotationIds = new Set(rotations.map((r) => r._id.toString()));
  const guildIds = new Set(guilds.map((g) => g._id.toString()));
  const activeGuildIds = new Set(guilds.filter((g) => !g.disabled).map((g) => g._id.toString()));

  // Scores
  const withoutAccount = scores.filter((s) => !s.bbs_id);

  const orphanGroups = new Map();
  for (const s of scores) {
    if (!s.bbs_id || knownBbsIds.has(s.bbs_id)) continue;
    const group = orphanGroups.get(s.bbs_id) ?? { bbs_id: s.bbs_id, bbs_name: s.bbs_name ?? null, scores: 0 };
    group.scores += 1;
    orphanGroups.set(s.bbs_id, group);
  }

  const seen = new Map();
  const duplicates = [];
  for (const s of scores) {
    if (!s.bbs_id) continue;
    const key = `${s.bbs_id}|${s.cycle_id}|${s.rotation_id}`;
    if (seen.has(key)) duplicates.push(scoreSample(s));
    else seen.set(key, s);
  }

  const implausible = scores.filter((s) => (s.score || 0) > MAX_PLAUSIBLE_SCORE).map(scoreSample);
  const unknownGuild = scores.filter((s) => s.guild_id && !guildIds.has(s.guild_id)).map(scoreSample);
  const unknownCycle = scores.filter((s) => s.cycle_id && !cycleById.has(s.cycle_id)).map(scoreSample);

  // Cycles
  const scoredRotations = new Set(scores.map((s) => `${s.cycle_id}|${s.rotation_id}`));
  const emptyRotations = [];
  const missingDates = [];
  const unknownRotations = [];
  for (const cycle of cycles) {
    for (const r of cycle.rotations || []) {
      const label = { cycle: cycleLabel(cycle._id.toString()), position: r.position ?? null };
      if (!parseDate(r.start_date) || !parseDate(r.end_date)) missingDates.push(label);
      if (r.rotation_id && !knownRotationIds.has(r.rotation_id)) unknownRotations.push(label);
      const end = parseDate(r.end_date);
      // Finished for more than a day, and nobody has a score on it
      if (end && end + 2 * DAY_MS <= now && !scoredRotations.has(`${cycle._id}|${r.rotation_id}`)) {
        emptyRotations.push({ ...label, end_date: r.end_date });
      }
    }
  }

  // Accounts
  const withoutGuild = accounts
    .filter((a) => !a.user.is_banned && !a.guilde_id)
    .map((a) => ({ bbs_id: a.bbs_id ?? null, bbs_name: a.bbs_name ?? null }));
  const inactiveGuild = accounts
    .filter((a) => !a.user.is_banned && a.guilde_id && !activeGuildIds.has(a.guilde_id))
    .map((a) => ({ bbs_id: a.bbs_id ?? null, bbs_name: a.bbs_name ?? null }));
  const byName = new Map();
  for (const a of accounts) {
    const name = a.bbs_name?.trim().toLowerCase();
    if (!name) continue;
    byName.set(name, [...(byName.get(name) ?? []), a]);
  }
  const duplicateNames = [...byName.values()]
    .filter((list) => new Set(list.map((a) => a.user._id.toString())).size > 1)
    .map((list) => ({ bbs_name: list[0].bbs_name, bbs_ids: list.map((a) => a.bbs_id) }));

  // Settings and indexes
  const missingIndexes = [];
  const indexesByCollection = new Map();
  for (const { collection, key } of INDEXES) {
    if (!indexesByCollection.has(collection)) {
      indexesByCollection.set(collection, await db.collection(collection).indexes().catch(() => []));
    }
    if (!hasIndex(indexesByCollection.get(collection), key)) missingIndexes.push({ collection, key });
  }

  return [
    check('duplicate_scores', 'error', duplicates),
    check('implausible_scores', 'error', implausible),
    check('scores_unknown_cycle', 'error', unknownCycle),
    check('scores_without_account', 'warning', withoutAccount.map(scoreSample)),
    check('orphan_scores', 'warning', [...orphanGroups.values()].sort((a, b) => b.scores - a.scores)),
    check('scores_unknown_guild', 'warning', unknownGuild),
    check('rotations_missing_dates', 'warning', missingDates),
    check('rotations_unknown_killer', 'warning', unknownRotations),
    check('podium_threshold_off', 'warning', minScores > 0 ? [] : [{ value: minScores }]),
    check('missing_indexes', 'warning', missingIndexes),
    check('duplicate_bbs_names', 'info', duplicateNames),
    check('empty_rotations', 'info', emptyRotations),
    check('accounts_inactive_guild', 'info', inactiveGuild),
    check('accounts_without_guild', 'info', withoutGuild),
  ];
};
