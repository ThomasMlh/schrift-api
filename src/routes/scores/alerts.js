import express from 'express';
import { ObjectId } from 'mongodb';
import { requireScoresAccess } from '../../middleware/auth.js';
import { getDeclineAlerts } from '../../services/playerTrends.js';
import { getScoreAnomalies, reviewScoreAnomaly } from '../../services/scoreAnomalies.js';
import { getScoreHistory, isScoreHistoryAction } from '../../services/scoreHistory.js';
import { sendServerError } from '../../utils/httpErrors.js';

const router = express.Router();

// Outils de suivi des scores pour chefs et admins. Périmètre : un chef/sous-chef ne voit que ses
// guildes ; un admin voit tout (ou la guilde ?guild_id=).

class ScopeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Guildes visibles pour la requête. `adminDefault` : 'active' = toutes les guildes actives,
 * 'all' = pas de restriction (null), quand l'admin ne précise pas de guilde.
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

const handleError = (res, err) => {
  if (err instanceof ScopeError) return res.status(err.status).json({ success: false, message: err.message });
  return sendServerError(res, err);
};

// GET baisses de régime : membres dont les derniers scores sont nettement sous leur habitude.
router.get('/decline-alerts', requireScoresAccess, async (req, res) => {
  try {
    const guildIds = await resolveGuildScope(req);
    const alerts = await getDeclineAlerts(req.db, { guildIds });
    res.json({ success: true, alerts });
  } catch (err) {
    handleError(res, err);
  }
});

// GET scores à vérifier (probables erreurs de saisie) sur les cycles récents.
router.get('/anomalies', requireScoresAccess, async (req, res) => {
  try {
    const guildIds = await resolveGuildScope(req);
    const anomalies = await getScoreAnomalies(req.db, { guildIds });
    res.json({ success: true, anomalies });
  } catch (err) {
    handleError(res, err);
  }
});

// POST marque un score comme vérifié (il ne remonte plus tant que sa valeur ne change pas).
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

// GET historique des modifications de scores (filtres : guild_id, cycle_id, bbs_id, score_id, action).
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
