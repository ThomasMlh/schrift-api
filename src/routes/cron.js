import express from 'express';
import { requireDb } from '../middleware/auth.js';
import { publishPendingCycleRecaps } from '../services/cycleRecap.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// Tâches planifiées appelées par Vercel Cron (vercel.json), qui envoie
// "Authorization: Bearer <CRON_SECRET>". Fail closed si le secret n'est pas configuré.
const requireCronSecret = (req, res, next) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return res.status(503).json({ success: false, message: 'CRON_SECRET non configuré côté serveur' });
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ success: false, message: 'Non autorisé' });
  }
  next();
};

router.use(requireCronSecret, requireDb);

// GET récap automatique des cycles terminés (si activé dans les réglages du podium)
router.get('/cycle-recap', async (req, res) => {
  try {
    const result = await publishPendingCycleRecaps(req.db);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error('[cron] Erreur récap automatique de cycle:', err);
    res.status(500).json({ success: false, message: 'Erreur serveur lors du récap automatique' });
  }
});

export default router;
