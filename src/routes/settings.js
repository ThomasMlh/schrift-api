import express from 'express';
import { requireDb, requireAdmin } from '../middleware/auth.js';
import { sanitizeDisabledTypes } from '../utils/notificationTypes.js';

const router = express.Router();

router.use(requireDb);

// Récupérer les settings de notification globaux (types hors-guilde : ban, unban, ...)
router.get('/notifications', requireAdmin, async (req, res) => {
  try {
    const settings = await req.db.collection('app_settings').findOne({ _id: 'notifications' });
    res.json({ success: true, disabled_notification_types: settings?.disabled_notification_types || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
