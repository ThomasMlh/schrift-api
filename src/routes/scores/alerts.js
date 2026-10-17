import express from 'express';
import { ObjectId } from 'mongodb';
import { requireScoresAccess } from '../../middleware/auth.js';
import { getDeclineAlerts } from '../../services/playerTrends.js';
import { getScoreAnomalies, reviewScoreAnomaly } from '../../services/scoreAnomalies.js';
import { getScoreHistory, isScoreHistoryAction } from '../../services/scoreHistory.js';
import { getMissingScores, getRotationPreparation, markJoinedAfterRotation } from '../../services/guildTools.js';
import { getBulkEntryContext } from '../../services/bulkEntryContext.js';
import { sendServerError } from '../../utils/httpErrors.js';

const router = express.Router();

// Score monitoring tools for leaders and admins. Scope: a leader/officer only sees their guilds;
// an admin sees everything (or the ?guild_id= guild).

class ScopeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Guilds visible to the request. `adminDefault`: 'active' = every active guild, 'all' = no
 * restriction (null), when the admin does not specify a guild.
 */
const resolveGuildScope = async (req, { adminDefault = 'active' } = {}) => {
  const { guild_id } = req.query;
  if (guild_id && !ObjectId.isValid(guild_id)) throw new ScopeError(400, 'guild_id invalide');

  if (req.user.hasFullAccess) {
    if (guild_id) return [guild_id];
    if (adminDefault === 'all') return null;
    return (await req.db.collection('guildes').find({ disabled: { $ne: true } }, { projection: { _id: 1 } }).toArray())
      .map((g) => g._id.toString());
  }

  const allowed = req.user.allowedGuildIds || [];
  if (guild_id && !allowed.includes(guild_id)) throw new ScopeError(403, 'Accès refusé à cette guilde');
  return guild_id ? [guild_id] : allowed;
};

// A single guild: the requested one (?guild_id=), or the only guild the leader manages.
const resolveSingleGuild = async (req) => {
  const guildIds = await resolveGuildScope(req);
  if (!req.query.guild_id && guildIds.length !== 1) throw new ScopeError(400, 'guild_id requis');
  return guildIds[0];
};

const handleError = (res, err) => {
  if (err instanceof ScopeError) return res.status(err.status).json({ success: false, message: err.message });
  return sendServerError(res, err);
};

// GET declines: members whose latest scores are well below their usual level.
router.get('/decline-alerts', requireScoresAccess, async (req, res) => {
  try {
    const guildIds = await resolveGuildScope(req);
    const alerts = await getDeclineAlerts(req.db, { guildIds });
    res.json({ success: true, alerts });
  } catch (err) {
    handleError(res, err);
  }
});

// GET bulk entry references (usual score, differential base) of the given accounts on a rotation of
// a cycle. Declared here rather than in bulk.js, otherwise GET /:id (crud) would catch it.
router.get('/bulk-context', requireScoresAccess, async (req, res) => {
  try {
    await resolveSingleGuild(req);
    const { cycle_id, rotation_id } = req.query;
    if (!cycle_id || !rotation_id) return res.status(400).json({ success: false, message: 'cycle_id et rotation_id requis' });
    const bbsIds = String(req.query.bbs_ids || '').split(',').map((id) => id.trim()).filter(Boolean).slice(0, 200);
    const context = await getBulkEntryContext(req.db, { cycleId: cycle_id, rotationId: rotation_id, bbsIds });
    res.json({ success: true, ...context });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    handleError(res, err);
  }
});

// GET scores to review (probable typos) on recent cycles.
router.get('/anomalies', requireScoresAccess, async (req, res) => {
  try {
    const guildIds = await resolveGuildScope(req);
    const anomalies = await getScoreAnomalies(req.db, { guildIds });
    res.json({ success: true, anomalies });
  } catch (err) {
    handleError(res, err);
  }
});

// POST mark a score as reviewed (it no longer shows up until its value changes).
router.post('/:id/anomaly-review', requireScoresAccess, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'ID de score invalide' });
    }
    const score = await req.db.collection('scores').findOne({ _id: new ObjectId(req.params.id) });
    if (!score) return res.status(404).json({ success: false, message: 'Score non trouvé' });
    if (!req.user.hasFullAccess && !(req.user.allowedGuildIds || []).includes(score.guild_id)) {
      return res.status(403).json({ success: false, message: 'Accès refusé à ce score' });
    }

    await reviewScoreAnomaly(req.db, score, req.user);
    res.json({ success: true, message: 'Score marqué comme vérifié' });
  } catch (err) {
    handleError(res, err);
  }
});

// GET missing scores of a cycle (current cycle by default) for the guild's current members.
router.get('/missing', requireScoresAccess, async (req, res) => {
  try {
    const guildId = await resolveSingleGuild(req);
    res.json({ success: true, ...(await getMissingScores(req.db, { guildId, cycleId: req.query.cycle_id })) });
  } catch (err) {
    handleError(res, err);
  }
});

// POST mark that a member joined the guild after a rotation (?guild_id=, body: bbs_id, cycle_id,
// rotation_id): that rotation and the earlier ones are no longer missing for them.
router.post('/missing/joined-after', requireScoresAccess, async (req, res) => {
  try {
    const guildId = await resolveSingleGuild(req);
    const { bbs_id, cycle_id, rotation_id } = req.body || {};
    if (!bbs_id || !cycle_id || !rotation_id) {
      return res.status(400).json({ success: false, message: 'bbs_id, cycle_id et rotation_id sont requis' });
    }
    const joinedAt = await markJoinedAfterRotation(req.db, { guildId, bbsId: bbs_id, cycleId: cycle_id, rotationId: rotation_id });
    if (!joinedAt) return res.status(404).json({ success: false, message: 'Membre ou rotation introuvable' });
    res.json({ success: true, guild_joined_at: joinedAt });
  } catch (err) {
    handleError(res, err);
  }
});

// GET rotation preparation sheet (next rotation of the current cycle by default).
router.get('/preparation', requireScoresAccess, async (req, res) => {
  try {
    const guildId = await resolveSingleGuild(req);
    const preparation = await getRotationPreparation(req.db, {
      guildId, cycleId: req.query.cycle_id, rotationId: req.query.rotation_id,
    });
    if (!preparation) return res.status(404).json({ success: false, message: 'Aucune rotation trouvée' });
    res.json({ success: true, ...preparation });
  } catch (err) {
    handleError(res, err);
  }
});

// GET score change history (filters: guild_id, cycle_id, bbs_id, score_id, action).
router.get('/history', requireScoresAccess, async (req, res) => {
  try {
    const { cycle_id, bbs_id, score_id, action, page, limit } = req.query;
    if (action && !isScoreHistoryAction(action)) {
      return res.status(400).json({ success: false, message: 'action invalide' });
    }
    const guildIds = await resolveGuildScope(req, { adminDefault: 'all' });
    const result = await getScoreHistory(req.db, {
      guildIds, cycleId: cycle_id, bbsId: bbs_id, scoreId: score_id, action, page, limit,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
