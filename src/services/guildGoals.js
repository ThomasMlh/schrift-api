import { ObjectId } from 'mongodb';
import { loadComparableScores, parseDate } from './killerRecords.js';
import { getCycleRecords } from './playerTrends.js';
import { getGuildScoreMatch, getGuildBbsIdsForCycle } from './podiumService/index.js';
import { CLEAR_SCORE_THRESHOLD } from '../utils/scoreThresholds.js';
import { getGuildAccountRoster } from '../utils/bbsAccounts.js';
import { wasMemberDuring } from './guildTools.js';

/**
 * A guild's goals on a cycle (`guild_goals` collection, one document per guild and cycle), set by
 * a leader or an admin. Progress uses the same scope as the podium: current members while the cycle
 * is running, otherwise the scores entered for the guild.
 */

// unit: percent (0-100), score (points), count
export const GOAL_TYPES = {
  average: { unit: 'score' },
  clear_rate: { unit: 'percent' },
  records: { unit: 'count' },
  participation: { unit: 'percent' },
};

const DAY_MS = 24 * 60 * 60 * 1000;

const validationError = (message) => Object.assign(new Error(message), { statusCode: 400 });

/** Validates and normalizes a goal list ({ type, target }); throws a 400 error otherwise. */
export const sanitizeGoals = (goals) => {
  if (!Array.isArray(goals)) throw validationError('goals doit être une liste');
  const seen = new Set();
  return goals.map((goal) => {
    const type = goal?.type;
    if (!GOAL_TYPES[type]) throw validationError(`Type d'objectif inconnu : ${type}`);
    if (seen.has(type)) throw validationError(`Objectif en double : ${type}`);
    seen.add(type);
    const target = Number(goal.target);
    if (!Number.isFinite(target) || target <= 0) throw validationError(`Cible invalide pour ${type}`);
    if (GOAL_TYPES[type].unit === 'percent' && target > 100) throw validationError(`La cible de ${type} ne peut pas dépasser 100 %`);
    return { type, target: GOAL_TYPES[type].unit === 'count' ? Math.round(target) : target };
  });
};

const average = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

/** Current value of each goal type for a guild on a cycle. */
const computeGoalValues = async (db, cycle, guildId, now) => {
  const cycleId = cycle._id.toString();
  const [match, bbsIds, roster] = await Promise.all([
    getGuildScoreMatch(db, cycle, guildId, now),
    getGuildBbsIdsForCycle(db, cycle, guildId, now),
    getGuildAccountRoster(db, guildId),
  ]);
  const [scores, entered, records] = await Promise.all([
    loadComparableScores(db, { cycle_id: cycleId, ...match }),
    db.collection('scores').find({ cycle_id: cycleId, ...match, score: { $gt: 0 } }, { projection: { bbs_id: 1, rotation_id: 1 } }).toArray(),
    getCycleRecords(db, cycle, bbsIds),
  ]);
  const values = scores.map((s) => s.score || 0);

  // Participation only counts the rotations that ended after each member joined the guild. Join
  // dates are only known for accounts still in the guild; the others owe every rotation. A score of 0
  // means the rotation was not played: `entered` leaves those out.
  const joinedAt = new Map(roster.map((m) => [m.bbs_id, m.guild_joined_at]));
  const endedRotations = (cycle.rotations || [])
    .filter((r) => (parseDate(r.end_date) || parseDate(r.start_date)) + DAY_MS <= now);
  const endedRotationById = new Map(endedRotations.map((r) => [r.rotation_id, r]));
  const expected = bbsIds.reduce(
    (sum, bbsId) => sum + endedRotations.filter((r) => wasMemberDuring(joinedAt.get(bbsId), r)).length, 0
  );
  const played = entered.filter((s) => {
    const rotation = endedRotationById.get(s.rotation_id);
    return rotation && wasMemberDuring(joinedAt.get(s.bbs_id), rotation);
  }).length;

  const avg = average(values);
  return {
    average: avg === null ? null : Math.round(avg),
    clear_rate: values.length ? Math.round((values.filter((v) => v >= CLEAR_SCORE_THRESHOLD).length / values.length) * 1000) / 10 : null,
    records: records.length,
    participation: expected ? Math.min(100, Math.round((played / expected) * 1000) / 10) : null,
  };
};

/**
 * A guild's goals on a cycle with their progress.
 * @returns {Promise<{ goals: Array, updated_at: Date|null, updated_by: string|null }>}
 */
export const getGuildGoals = async (db, cycle, guildId, now = Date.now()) => {
  const doc = await db.collection('guild_goals').findOne({ guild_id: guildId, cycle_id: cycle._id.toString() });
  if (!doc?.goals?.length) return { goals: [], updated_at: null, updated_by: null };

  const values = await computeGoalValues(db, cycle, guildId, now);
  return {
    goals: doc.goals.map(({ type, target }) => {
      const value = values[type];
      return {
        type,
        unit: GOAL_TYPES[type].unit,
        target,
        value,
        progress: value === null ? 0 : Math.min(100, Math.round((value / target) * 1000) / 10),
        achieved: value !== null && value >= target,
      };
    }),
    updated_at: doc.updated_at || null,
    updated_by: doc.updated_by || null,
  };
};

/** Replaces a guild's goals on a cycle (empty list = no goals). */
export const setGuildGoals = async (db, { guildId, cycleId, goals, user }) => {
  const clean = sanitizeGoals(goals);
  if (!ObjectId.isValid(cycleId)) throw validationError('cycle_id invalide');
  const filter = { guild_id: guildId, cycle_id: cycleId };
  if (clean.length === 0) {
    await db.collection('guild_goals').deleteOne(filter);
    return clean;
  }
  await db.collection('guild_goals').updateOne(
    filter,
    { $set: { goals: clean, updated_at: new Date(), updated_by: user?._id?.toString() || user?.id?.toString() || null } },
    { upsert: true }
  );
  return clean;
};
