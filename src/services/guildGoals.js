import { ObjectId } from 'mongodb';
import { loadComparableScores, parseDate } from './killerRecords.js';
import { getCycleRecords } from './playerTrends.js';
import { getGuildScoreMatch, getGuildBbsIdsForCycle } from './podiumService/index.js';
import { CLEAR_SCORE_THRESHOLD } from '../utils/scoreThresholds.js';

/**
 * Objectifs d'une guilde sur un cycle (collection `guild_goals`, un document par guilde et par
 * cycle), fixés par un chef ou un admin. La progression suit le même périmètre que le podium :
 * membres actuels si le cycle est en cours, sinon les scores saisis pour la guilde.
 */

// unit : percent (0-100), score (points), count
export const GOAL_TYPES = {
  average: { unit: 'score' },
  clear_rate: { unit: 'percent' },
  records: { unit: 'count' },
  participation: { unit: 'percent' },
};

const DAY_MS = 24 * 60 * 60 * 1000;

const validationError = (message) => Object.assign(new Error(message), { statusCode: 400 });

/** Valide et normalise une liste d'objectifs ({ type, target }) ; lève une erreur 400 sinon. */
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

/** Valeur actuelle de chaque type d'objectif pour une guilde sur un cycle. */
const computeGoalValues = async (db, cycle, guildId, now) => {
  const cycleId = cycle._id.toString();
  const [match, bbsIds] = await Promise.all([
    getGuildScoreMatch(db, cycle, guildId, now),
    getGuildBbsIdsForCycle(db, cycle, guildId, now),
  ]);
  const [scores, played, records] = await Promise.all([
    loadComparableScores(db, { cycle_id: cycleId, ...match }),
    db.collection('scores').countDocuments({ cycle_id: cycleId, ...match }),
    getCycleRecords(db, cycle, bbsIds),
  ]);
  const values = scores.map((s) => s.score || 0);
  const endedRotations = (cycle.rotations || [])
    .filter((r) => (parseDate(r.end_date) || parseDate(r.start_date)) + DAY_MS <= now).length;
  const expected = bbsIds.length * endedRotations;

  const avg = average(values);
  return {
    average: avg === null ? null : Math.round(avg),
    clear_rate: values.length ? Math.round((values.filter((v) => v >= CLEAR_SCORE_THRESHOLD).length / values.length) * 1000) / 10 : null,
    records: records.length,
    participation: expected ? Math.min(100, Math.round((played / expected) * 1000) / 10) : null,
  };
};

/**
 * Objectifs d'une guilde sur un cycle avec leur progression.
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

/** Remplace les objectifs d'une guilde sur un cycle (liste vide = supprime les objectifs). */
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
