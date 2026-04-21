import express from 'express';
import { requireDb } from '../middleware/auth.js';
import { getPodium, getPodiumFull, getPodiumWeekly, getPodiumMisses } from '../services/podiumService.js';

const router = express.Router();

router.use(requireDb);

// GET podium simple (top 10)
router.get('/', async (req, res) => {
  try {
    const result = await getPodium(req.db, req.query);
    res.json({ success: true, ...result });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status === 500) console.error('Erreur lors de la creation du podium:', error);
    res.status(status).json({ success: false, message: error.message || 'Erreur serveur lors de la creation du podium' });
  }
});

// GET podium complet pagine
router.get('/full', async (req, res) => {
  try {
    const result = await getPodiumFull(req.db, req.query);
    res.json({ success: true, ...result });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status === 500) console.error('Erreur lors de la creation du podium complet:', error);
    res.status(status).json({ success: false, message: error.message || 'Erreur serveur lors de la creation du podium complet' });
  }
});

// GET podium hebdomadaire
router.get('/weekly', async (req, res) => {
  try {
    const result = await getPodiumWeekly(req.db, req.query);
    res.json({ success: true, ...result });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status === 500) console.error('Erreur lors de la creation du podium hebdomadaire:', error);
    res.status(status).json({ success: false, message: error.message || 'Erreur serveur lors de la creation du podium hebdomadaire' });
  }
});

// GET podium des miss
router.get('/misses', async (req, res) => {
  try {
    const result = await getPodiumMisses(req.db, req.query);
    res.json({ success: true, ...result });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status === 500) console.error('Erreur lors de la creation du podium des miss:', error);
    res.status(status).json({ success: false, message: error.message || 'Erreur serveur lors de la creation du podium des miss' });
  }
});

export default router;
