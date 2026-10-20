import express from 'express';
import { requireDb, requireAdmin } from '../middleware/auth.js';
import { syncDiscordProfiles } from '../utils/botClient.js';
import { sendStatusCodeError } from '../utils/httpErrors.js';
import { ensureIndexes } from '../services/dbIndexes.js';
import { getDataHealth } from '../services/dataHealth.js';

const router = express.Router();

router.use(requireDb);

// GET Discord bot health
router.get('/bot-health', requireAdmin, async (req, res) => {
  try {
    const healthUrl = `${process.env.BOT_WEBHOOK_URL || 'http://localhost:8080'}/health`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const botRes = await fetch(healthUrl, { signal: controller.signal });
      clearTimeout(timeout);
      const data = await botRes.json().catch(() => ({}));
      return res.json({ success: true, online: botRes.ok, status: botRes.status, data });
    } catch (fetchErr) {
      clearTimeout(timeout);
      const timedOut = fetchErr.name === 'AbortError';
      return res.json({ success: true, online: false, error: timedOut ? 'timeout' : fetchErr.message });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST resync players' Discord banners, avatars and names (admin "Tools" button)
router.post('/sync-profiles', requireAdmin, async (req, res) => {
  try {
    const result = await syncDiscordProfiles();
    res.json({ success: true, ...result });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur lors de la synchronisation des profils Discord');
  }
});

// POST create the database indexes (admin "Tools" button)
router.post('/create-indexes', requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, ...(await ensureIndexes(req.db)) });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur lors de la création des index');
  }
});

// GET data checks (admin "Data health" tab)
router.get('/data-health', requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, checks: await getDataHealth(req.db), checked_at: new Date() });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur lors de la vérification des données');
  }
});

export default router;