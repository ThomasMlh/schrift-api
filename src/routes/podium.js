import express from 'express';
import { requireDb, requireAdmin } from '../middleware/auth.js';
import { getPodium, getPodiumFull, getPodiumWeekly, getPodiumMisses, getDraftProposal } from '../services/podiumService.js';

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

// GET proposition de draft (admin) : répartition simulée par score sur un cycle
router.get('/draft-proposal', requireAdmin, async (req, res) => {
  try {
    const result = await getDraftProposal(req.db, req.query);
    res.json({ success: true, ...result });
  } catch (error) {
    const status = error.statusCode || 500;
    if (status === 500) console.error('Erreur lors de la génération de la proposition de draft:', error);
    res.status(status).json({ success: false, message: error.message || 'Erreur serveur lors de la génération de la proposition de draft' });
  }
});

export default router;
