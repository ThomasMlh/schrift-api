import express from 'express';
import { requireDb, requireAdmin } from '../middleware/auth.js';
import { sanitizeDisabledTypes } from '../utils/notificationTypes.js';
import { sendServerErrorWithFlag } from '../utils/httpErrors.js';

const router = express.Router();

router.use(requireDb);

// Récupérer les settings de notification globaux (types hors-guilde : ban, unban, ...)
router.get('/notifications', requireAdmin, async (req, res) => {
  try {
    const settings = await req.db.collection('app_settings').findOne({ _id: 'notifications' });
    res.json({ success: true, disabled_notification_types: settings?.disabled_notification_types || [] });
  } catch (err) {
    sendServerErrorWithFlag(res, err);
  }
});

// Mettre à jour les settings de notification globaux
router.put('/notifications', requireAdmin, async (req, res) => {
  try {
    const disabledTypes = sanitizeDisabledTypes(req.body.disabled_notification_types);

    await req.db.collection('app_settings').updateOne(
      { _id: 'notifications' },
      { $set: { disabled_notification_types: disabledTypes } },
      { upsert: true }
    );

    res.json({ success: true, message: 'Settings de notification mis à jour', disabled_notification_types: disabledTypes });
  } catch (err) {
    sendServerErrorWithFlag(res, err);
  }
});

// Récupérer le réglage du seuil minimum de scores pour apparaître au podium (moyenne)
router.get('/podium', requireAdmin, async (req, res) => {
  try {
    const settings = await req.db.collection('app_settings').findOne({ _id: 'podium' });
    res.json({
      success: true,
      min_scores_for_ranking: typeof settings?.min_scores_for_ranking === 'number' ? settings.min_scores_for_ranking : 0,
      auto_cycle_recap: settings?.auto_cycle_recap === true,
    });
  } catch (err) {
    sendServerErrorWithFlag(res, err);
  }
});

// Mettre à jour les réglages du podium (champs optionnels) : seuil minimum de scores
// (0 = désactivé) et envoi automatique du récap de fin de cycle
router.put('/podium', requireAdmin, async (req, res) => {
  try {
    const update = {};
    if (req.body.min_scores_for_ranking !== undefined) {
      const value = parseInt(req.body.min_scores_for_ranking, 10);
      if (isNaN(value) || value < 0) {
        return res.status(400).json({ success: false, message: 'min_scores_for_ranking doit être un entier positif ou nul' });
      }
      update.min_scores_for_ranking = value;
    }
    if (req.body.auto_cycle_recap !== undefined) {
      if (typeof req.body.auto_cycle_recap !== 'boolean') {
        return res.status(400).json({ success: false, message: 'auto_cycle_recap doit être un booléen' });
      }
      update.auto_cycle_recap = req.body.auto_cycle_recap;
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, message: 'Aucun réglage à mettre à jour' });
    }

    await req.db.collection('app_settings').updateOne({ _id: 'podium' }, { $set: update }, { upsert: true });

    res.json({ success: true, message: 'Réglages du podium mis à jour', ...update });
  } catch (err) {
    sendServerErrorWithFlag(res, err);
  }
});

export default router;
