import express from 'express';
import { requireDb, requireAdmin, requireAuth } from '../middleware/auth.js';
import { ALBUM_SETTINGS_ID, leadersCanEditAlbums } from '../services/albumSettings.js';
import { getScoreLockDays } from '../services/scoreLock.js';
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

// GET the number of days after a cycle ends before its scores are locked for leaders/officers
router.get('/scores', requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, lock_after_days: await getScoreLockDays(req.db) });
  } catch (err) {
    sendServerErrorWithFlag(res, err);
  }
});

// PUT the lock delay (0 = never locked)
router.put('/scores', requireAdmin, async (req, res) => {
  try {
    const value = parseInt(req.body.lock_after_days, 10);
    if (isNaN(value) || value < 0 || value > 365) {
      return res.status(400).json({ success: false, message: 'lock_after_days doit être un entier entre 0 et 365' });
    }

    await req.db.collection('app_settings').updateOne(
      { _id: 'scores' },
      { $set: { lock_after_days: value } },
      { upsert: true }
    );

    res.json({ success: true, message: 'Verrouillage des scores mis à jour', lock_after_days: value });
  } catch (err) {
    sendServerErrorWithFlag(res, err);
  }
});

// GET whether guild leaders and officers may fill their players' albums (read by any logged-in user,
// so the site shows them the edit controls)
router.get('/albums', requireAuth, async (req, res) => {
  try {
    res.json({ success: true, leaders_can_edit: await leadersCanEditAlbums(req.db) });
  } catch (err) {
    sendServerErrorWithFlag(res, err);
  }
});

// PUT the album option (admins only)
router.put('/albums', requireAdmin, async (req, res) => {
  try {
    if (typeof req.body.leaders_can_edit !== 'boolean') {
      return res.status(400).json({ success: false, message: 'leaders_can_edit doit être un booléen' });
    }
    await req.db.collection('app_settings').updateOne(
      { _id: ALBUM_SETTINGS_ID },
      { $set: { leaders_can_edit: req.body.leaders_can_edit } },
      { upsert: true }
    );
    res.json({ success: true, message: 'Option des albums mise à jour', leaders_can_edit: req.body.leaders_can_edit });
  } catch (err) {
    sendServerErrorWithFlag(res, err);
  }
});

export default router;
