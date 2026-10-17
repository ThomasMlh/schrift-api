import express from 'express';
import { requireDb, requireAdmin } from '../middleware/auth.js';
import { sanitizeDisabledTypes } from '../utils/notificationTypes.js';
import { sendServerErrorWithFlag } from '../utils/httpErrors.js';

const router = express.Router();

router.use(requireDb);

// GET global notification settings (non-guild types: ban, unban, …)
router.get('/notifications', requireAdmin, async (req, res) => {
  try {
    const settings = await req.db.collection('app_settings').findOne({ _id: 'notifications' });
    res.json({ success: true, disabled_notification_types: settings?.disabled_notification_types || [] });
  } catch (err) {
    sendServerErrorWithFlag(res, err);
  }
});

// PUT global notification settings
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

// GET the minimum number of scores to appear on the podium (average ranking)
router.get('/podium', requireAdmin, async (req, res) => {
  try {
    const settings = await req.db.collection('app_settings').findOne({ _id: 'podium' });
    res.json({
      success: true,
      min_scores_for_ranking: typeof settings?.min_scores_for_ranking === 'number' ? settings.min_scores_for_ranking : 0,
    });
  } catch (err) {
    sendServerErrorWithFlag(res, err);
  }
});

// PUT the threshold (0 = disabled)
router.put('/podium', requireAdmin, async (req, res) => {
  try {
    const value = parseInt(req.body.min_scores_for_ranking, 10);
    if (isNaN(value) || value < 0) {
      return res.status(400).json({ success: false, message: 'min_scores_for_ranking doit être un entier positif ou nul' });
    }

    await req.db.collection('app_settings').updateOne(
      { _id: 'podium' },
      { $set: { min_scores_for_ranking: value } },
      { upsert: true }
    );

    res.json({ success: true, message: 'Seuil du podium mis à jour', min_scores_for_ranking: value });
  } catch (err) {
    sendServerErrorWithFlag(res, err);
  }
});

export default router;
