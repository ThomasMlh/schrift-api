import { ObjectId } from 'mongodb';
import { notifyDiscord } from '../utils/notifyDiscord.js';
import { logger } from '../utils/logger.js';

/**
 * Records and history per killer.
 *
 * A `rotations` document is a template (killer + attack type + alteration) reused across cycles, so
 * comparing scores "on the same killer" means comparing them for the same rotation_id.
 * The `score` field (points earned on the rotation itself) is comparable across cycles even when a
 * killer moves from a base rotation to a differential one; `raw_score` (weekly running total) is not.
 */

// Rotation dates are stored as "dd/mm/yyyy" (a Date object is also accepted)
export const parseDate = (s) => {
  if (!s) return 0;
  if (s instanceof Date) return s.getTime() || 0;
  if (typeof s !== 'string') return 0;
  const [day, month, year] = s.split('/');
  return new Date(year, month - 1, day).getTime() || 0;
};

export const cycleTimestamp = (cycle) => parseDate(cycle.rotations?.[0]?.start_date) || new Date(cycle.created_at || 0).getTime();

export const toObjectIds = (ids) => ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));

/**
 * Loads the scores matching the filter, leaving out non-comparable ones: a differential score without
 * a base score in the same week of the same cycle holds the whole weekly total (computeDifferential
 * falls back to raw_score without a base), not the rotation's points, and would create false records.
 */
export const loadComparableScores = async (db, filter) => {
  const scores = await db.collection('scores').find({ bbs_id: { $ne: null }, ...filter }).toArray();
  const differentials = scores.filter((s) => s.is_differential);
  if (differentials.length === 0) return scores;

  const cycleIds = [...new Set(differentials.map((s) => s.cycle_id))];
  const cycles = await db.collection('cycles')
    .find({ _id: { $in: toObjectIds(cycleIds) } }, { projection: { rotations: 1 } })
    .toArray();

  // `${cycle_id}|${rotation_id}` -> rotation_id of the previous rotation in that cycle
  const previousRotation = new Map();
  for (const cycle of cycles) {
    (cycle.rotations || []).forEach((r, i) => {
      if (i > 0) previousRotation.set(`${cycle._id}|${r.rotation_id}`, cycle.rotations[i - 1].rotation_id);
    });
  }

  const baseKeyOf = (s) => `${s.cycle_id}|${s.bbs_id}|${previousRotation.get(`${s.cycle_id}|${s.rotation_id}`)}`;
  const baseRotationIds = [...new Set(differentials.map((s) => previousRotation.get(`${s.cycle_id}|${s.rotation_id}`)).filter(Boolean))];

  const bases = await db.collection('scores').find(
    {
      cycle_id: { $in: cycleIds },
      rotation_id: { $in: baseRotationIds },
      bbs_id: { $in: [...new Set(differentials.map((s) => s.bbs_id))] },
    },
    { projection: { cycle_id: 1, bbs_id: 1, rotation_id: 1 } }
  ).toArray();
  const existingBases = new Set(bases.map((b) => `${b.cycle_id}|${b.bbs_id}|${b.rotation_id}`));

  return scores.filter((s) => !s.is_differential || existingBases.has(baseKeyOf(s)));
};

const bestOf = (scores) => scores.reduce((best, s) => ((s.score || 0) > (best?.score || 0) ? s : best), null);
export const average = (scores) => (scores.length ? Math.round(scores.reduce((sum, s) => sum + (s.score || 0), 0) / scores.length) : null);

/**
 * A killer's history across all cycles: records (absolute, and the guild's when guildId is given),
 * per-cycle averages, and the "score to beat" for currentCycleId (best score of the OTHER cycles,
 * within the guild scope when guildId is given). A score's guild is the one it was entered for
 * (score.guild_id): this reflects what the guild achieved, not its current roster.
 */
export const getRotationHistory = async (db, rotationId, { guildId, currentCycleId } = {}) => {
  const scores = await loadComparableScores(db, { rotation_id: rotationId });

  const cycleIds = [...new Set(scores.map((s) => s.cycle_id))];
  const cycles = await db.collection('cycles')
    .find({ _id: { $in: toObjectIds(cycleIds) } }, { projection: { name: 1, year: 1, rotations: 1, created_at: 1 } })
    .toArray();
  const cycleById = new Map(cycles.map((c) => [c._id.toString(), c]));

  const guildIds = [...new Set(scores.map((s) => s.guild_id).filter(Boolean))];
  const guilds = await db.collection('guildes')
    .find({ _id: { $in: toObjectIds(guildIds) } }, { projection: { name: 1 } })
    .toArray();
  const guildNameById = new Map(guilds.map((g) => [g._id.toString(), g.name]));

  const describe = (s) => {
    if (!s || !(s.score > 0)) return null;
    const cycle = cycleById.get(s.cycle_id);
    return {
      score: s.score,
      bbs_id: s.bbs_id,
      bbs_name: s.bbs_name || null,
      guild_id: s.guild_id || null,
      guild_name: guildNameById.get(s.guild_id) || null,
      cycle_id: s.cycle_id,
      cycle_name: cycle?.name || null,
      cycle_year: cycle?.year || null,
    };
  };

  const scoped = guildId ? scores.filter((s) => s.guild_id === guildId) : scores;

  const perCycle = cycles
    .sort((a, b) => cycleTimestamp(a) - cycleTimestamp(b))
    .map((cycle) => {
      const id = cycle._id.toString();
      const cycleScores = scores.filter((s) => s.cycle_id === id);
      const guildScores = guildId ? cycleScores.filter((s) => s.guild_id === guildId) : null;
      return {
        cycle_id: id,
        cycle_name: cycle.name,
        cycle_year: cycle.year,
        average: average(cycleScores),
        count: cycleScores.length,
        guild_average: guildScores ? average(guildScores) : null,
        guild_count: guildScores ? guildScores.length : null,
      };
    });

  const currentCycleScores = currentCycleId ? scoped.filter((s) => s.cycle_id === currentCycleId) : [];
  const previousScores = currentCycleId ? scoped.filter((s) => s.cycle_id !== currentCycleId) : [];

  return {
    rotation_id: rotationId,
    absolute_record: describe(bestOf(scores)),
    guild_record: guildId ? describe(bestOf(scoped)) : null,
    record_to_beat: currentCycleId ? describe(bestOf(previousScores)) : null,
    current_cycle_best: currentCycleId ? describe(bestOf(currentCycleScores)) : null,
    per_cycle: perCycle,
  };
};

/**
 * Best score of each bbs account on each killer (personal records, for the player page).
 * @returns {Promise<Map<string, Array>>} bbs_id -> records sorted by killer
 */
export const getAccountRecords = async (db, bbsIds) => {
  if (bbsIds.length === 0) return new Map();
  const scores = await loadComparableScores(db, { bbs_id: { $in: bbsIds } });

  const bestByKey = new Map();
  const attemptsByKey = new Map();
  for (const s of scores) {
    const key = `${s.bbs_id}|${s.rotation_id}`;
    attemptsByKey.set(key, (attemptsByKey.get(key) || 0) + 1);
    if ((s.score || 0) > (bestByKey.get(key)?.score || 0)) bestByKey.set(key, s);
  }

  const rotationIds = [...new Set([...bestByKey.values()].map((s) => s.rotation_id))];
  const cycleIds = [...new Set([...bestByKey.values()].map((s) => s.cycle_id))];
  const [rotations, cycles] = await Promise.all([
    db.collection('rotations').find({ _id: { $in: toObjectIds(rotationIds) } }).toArray(),
    db.collection('cycles').find({ _id: { $in: toObjectIds(cycleIds) } }, { projection: { name: 1, year: 1 } }).toArray(),
  ]);
  const rotationById = new Map(rotations.map((r) => [r._id.toString(), r]));
  const cycleById = new Map(cycles.map((c) => [c._id.toString(), c]));

  const recordsByAccount = new Map(bbsIds.map((id) => [id, []]));
  for (const [key, s] of bestByKey) {
    const rotation = rotationById.get(s.rotation_id);
    const cycle = cycleById.get(s.cycle_id);
    recordsByAccount.get(s.bbs_id)?.push({
      rotation_id: s.rotation_id,
      killer: rotation?.killer || null,
      attack: rotation?.attack || null,
      alteration: rotation?.alteration || null,
      score: s.score,
      cycle_id: s.cycle_id,
      cycle_name: cycle?.name || null,
      cycle_year: cycle?.year || null,
      attempts: attemptsByKey.get(key),
    });
  }
  for (const records of recordsByAccount.values()) {
    records.sort((a, b) => (a.killer || '').localeCompare(b.killer || '') || (a.attack || '').localeCompare(b.attack || ''));
  }
  return recordsByAccount;
};

/**
 * Among newly inserted scores, finds those beating the same account's previous best on the same
 * killer (earlier cycles only). The first score ever entered on a killer is not a record (nothing to
 * beat), and neither is a non-comparable score.
 */
export const findNewRecords = async (db, insertedScores) => {
  const candidates = insertedScores.filter((s) => s.bbs_id && s.rotation_id && s.cycle_id && (s.score || 0) > 0);
  if (candidates.length === 0) return [];

  const comparable = await loadComparableScores(db, {
    bbs_id: { $in: [...new Set(candidates.map((s) => s.bbs_id))] },
    rotation_id: { $in: [...new Set(candidates.map((s) => s.rotation_id))] },
  });

  const records = [];
  for (const candidate of candidates) {
    const sameKiller = comparable.filter((s) => s.bbs_id === candidate.bbs_id && s.rotation_id === candidate.rotation_id);
    const current = sameKiller.find((s) => s.cycle_id === candidate.cycle_id);
    if (!current) continue; // Not comparable (differential without a base score)

    const previousBest = bestOf(sameKiller.filter((s) => s.cycle_id !== candidate.cycle_id));
    if (!previousBest || !(current.score > previousBest.score)) continue;

    records.push({
      bbs_id: candidate.bbs_id,
      bbs_name: current.bbs_name || candidate.bbs_name || null,
      guild_id: current.guild_id || candidate.guild_id || null,
      rotation_id: candidate.rotation_id,
      cycle_id: candidate.cycle_id,
      previous_score: previousBest.score,
      new_score: current.score,
    });
  }
  return records;
};

/**
 * Detects records among newly inserted scores and sends one message per guild (general channel,
 * falling back to the leaders channel). Never throws: a detection or notification failure must not
 * fail the score entry.
 * @returns {Promise<number>} number of records detected
 */
export const notifyPersonalRecords = async (db, insertedScores) => {
  try {
    const records = await findNewRecords(db, insertedScores);
    if (records.length === 0) return 0;

    const rotationIds = [...new Set(records.map((r) => r.rotation_id))];
    const rotations = await db.collection('rotations').find({ _id: { $in: toObjectIds(rotationIds) } }).toArray();
    const rotationById = new Map(rotations.map((r) => [r._id.toString(), r]));

    const byGuild = new Map();
    for (const record of records) {
      if (!record.guild_id) continue;
      if (!byGuild.has(record.guild_id)) byGuild.set(record.guild_id, []);
      byGuild.get(record.guild_id).push(record);
    }

    for (const [guildId, guildRecords] of byGuild) {
      if (!ObjectId.isValid(guildId)) continue;
      const guild = await db.collection('guildes').findOne({ _id: new ObjectId(guildId) });
      const channelId = guild?.discord_general_channel_id || guild?.discord_channel_id;
      if (!channelId) continue;

      const cycleIds = [...new Set(guildRecords.map((r) => r.cycle_id))];
      const cycle = ObjectId.isValid(cycleIds[0])
        ? await db.collection('cycles').findOne({ _id: new ObjectId(cycleIds[0]) }, { projection: { name: 1 } })
        : null;

      await notifyDiscord('personal_record', {
        guild_name: guild.name || '',
        cycle_name: cycle?.name || '',
        records: guildRecords.map((r) => ({
          pseudo: r.bbs_name || r.bbs_id,
          killer: rotationById.get(r.rotation_id)?.killer || '',
          attack: rotationById.get(r.rotation_id)?.attack || '',
          previous_score: r.previous_score,
          new_score: r.new_score,
        })),
      }, channelId);
    }

    return records.length;
  } catch (err) {
    logger.error('[killerRecords] Erreur détection/notification des records (non bloquant):', err.message);
    return 0;
  }
};
