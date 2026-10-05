import { logger } from '../utils/logger.js';
import { getUserDisplayName } from '../utils/nameMatching.js';
import { toObjectIds } from './killerRecords.js';
import { invalidateAchievementsCache } from './achievements.js';

/**
 * Historique des modifications de scores (collection `score_history`) : une entrée par création,
 * modification, suppression, transfert ou recalcul automatique d'un score, avec l'état avant/après
 * et l'auteur. Sert en cas de litige ou d'erreur de saisie.
 */

export const SCORE_HISTORY_ACTIONS = ['create', 'update', 'delete', 'transfer_account', 'transfer_rotation', 'recalculate'];

const SNAPSHOT_FIELDS = ['score', 'raw_score', 'is_differential', 'bbs_id', 'bbs_name', 'guild_id', 'rotation_id', 'cycle_id'];

const snapshot = (doc) => {
  if (!doc) return null;
  const snap = {};
  for (const field of SNAPSHOT_FIELDS) {
    if (doc[field] !== undefined) snap[field] = doc[field];
  }
  return snap;
};

// Auteur à partir du JWT (req.user) ; null pour un recalcul automatique.
const authorOf = (user) => (user ? (user._id?.toString() || user.id?.toString() || user.discord_id || null) : null);

/**
 * Enregistre un changement. `before`/`after` sont des documents score (ou null pour une création /
 * une suppression). Une modification sans changement réel n'est pas enregistrée. Ne lève jamais.
 */
export const recordScoreChange = async (db, { action, source = 'manual', scoreId, before = null, after = null, user = null }) => {
  // Tout changement de score peut débloquer ou retirer un succès
  invalidateAchievementsCache();
  try {
    const beforeSnap = snapshot(before);
    const afterSnap = snapshot(after ? { ...before, ...after } : null);
    if (beforeSnap && afterSnap && JSON.stringify(beforeSnap) === JSON.stringify(afterSnap)) return;

    const ref = afterSnap || beforeSnap || {};
    await db.collection('score_history').insertOne({
      score_id: (scoreId || before?._id || after?._id)?.toString() || null,
      action,
      source,
      cycle_id: ref.cycle_id || null,
      rotation_id: ref.rotation_id || null,
      bbs_id: ref.bbs_id || null,
      bbs_name: ref.bbs_name || null,
      guild_id: ref.guild_id || null,
      before: beforeSnap,
      after: afterSnap,
      by_user_id: authorOf(user),
      created_at: new Date(),
    });
  } catch (err) {
    logger.error('[scoreHistory] Échec de journalisation (non bloquant):', err.message);
  }
};

/**
 * Liste paginée de l'historique, du plus récent au plus ancien, avec le nom de l'auteur, de la
 * guilde, du cycle et le killer de la rotation. `guildIds` restreint aux guildes données (chefs) :
 * une entrée est visible si le score appartenait à l'une d'elles avant OU après le changement.
 */
export const getScoreHistory = async (db, { guildIds = null, scoreId, cycleId, bbsId, action, page = 1, limit = 50 }) => {
  const filter = {};
  if (scoreId) filter.score_id = scoreId;
  if (cycleId) filter.cycle_id = cycleId;
  if (bbsId) filter.bbs_id = bbsId;
  if (action) filter.action = action;
  if (guildIds) filter.$or = [{ guild_id: { $in: guildIds } }, { 'before.guild_id': { $in: guildIds } }];

  const pageNumber = Math.max(1, parseInt(page, 10) || 1);
  const limitNumber = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

  const [entries, totalCount] = await Promise.all([
    db.collection('score_history').find(filter)
      .sort({ created_at: -1, _id: -1 })
      .skip((pageNumber - 1) * limitNumber)
      .limit(limitNumber)
      .toArray(),
    db.collection('score_history').countDocuments(filter),
  ]);

  const ids = (key) => [...new Set(entries.map((e) => e[key]).filter(Boolean))];
  const [users, guilds, cycles, rotations] = await Promise.all([
    db.collection('users').find(
      { $or: [{ _id: { $in: toObjectIds(ids('by_user_id')) } }, { discord_id: { $in: ids('by_user_id') } }] },
      { projection: { username: 1, global_name: 1, bbs_name: 1, discord_id: 1 } }
    ).toArray(),
    db.collection('guildes').find({ _id: { $in: toObjectIds(ids('guild_id')) } }, { projection: { name: 1 } }).toArray(),
    db.collection('cycles').find({ _id: { $in: toObjectIds(ids('cycle_id')) } }, { projection: { name: 1, year: 1, rotations: 1 } }).toArray(),
    db.collection('rotations').find({ _id: { $in: toObjectIds(ids('rotation_id')) } }, { projection: { killer: 1, attack: 1, alteration: 1 } }).toArray(),
  ]);

  const userById = new Map();
  for (const u of users) {
    userById.set(u._id.toString(), u);
    if (u.discord_id) userById.set(u.discord_id, u);
  }
  const guildById = new Map(guilds.map((g) => [g._id.toString(), g.name]));
  const cycleById = new Map(cycles.map((c) => [c._id.toString(), c]));
  const rotationById = new Map(rotations.map((r) => [r._id.toString(), r]));

  return {
    entries: entries.map((e) => {
      const author = userById.get(e.by_user_id);
      const cycle = cycleById.get(e.cycle_id);
      const rotation = rotationById.get(e.rotation_id);
      return {
        _id: e._id.toString(),
        score_id: e.score_id,
        action: e.action,
        source: e.source,
        bbs_id: e.bbs_id,
        bbs_name: e.bbs_name,
        guild_id: e.guild_id,
        guild_name: guildById.get(e.guild_id) || null,
        cycle_id: e.cycle_id,
        cycle_name: cycle?.name || null,
        cycle_year: cycle?.year || null,
        rotation_id: e.rotation_id,
        rotation_position: cycle?.rotations?.find((r) => r.rotation_id === e.rotation_id)?.position ?? null,
        killer: rotation?.killer || null,
        attack: rotation?.attack || null,
        before: e.before,
        after: e.after,
        by_user_id: e.by_user_id,
        by_name: author ? getUserDisplayName(author, null) : null,
        created_at: e.created_at,
      };
    }),
    pagination: {
      currentPage: pageNumber,
      totalPages: Math.ceil(totalCount / limitNumber),
      totalCount,
      hasNextPage: pageNumber * limitNumber < totalCount,
      hasPrevPage: pageNumber > 1,
      itemsPerPage: limitNumber,
      itemsOnPage: entries.length,
    },
  };
};

export const isScoreHistoryAction = (action) => SCORE_HISTORY_ACTIONS.includes(action);
