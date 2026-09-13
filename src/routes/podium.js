import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb, requireAdmin } from '../middleware/auth.js';
import { getPodium, getPodiumFull, getPodiumWeekly, getPodiumMisses, getDraftProposal } from '../services/podiumService.js';
import { getUserDisplayName } from '../utils/nameMatching.js';
import { USER_DISPLAY } from '../utils/projections.js';

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

    // Historique (non bloquant, après la réponse) : garde une trace de ce qui a été généré,
    // avec le résultat complet, pour le consulter plus tard sans avoir à tout recalculer.
    try {
      const submitter = req.user?._id
        ? await req.db.collection('users').findOne({ _id: new ObjectId(req.user._id) }, { projection: USER_DISPLAY })
        : null;
      await req.db.collection('draft_proposals').insertOne({
        created_at: new Date(),
        created_by: getUserDisplayName(submitter),
        cycle_name: req.query.cycle_name,
        ranking_type: result.meta.rankingType,
        guild_order: result.meta.guildOrder,
        total_candidates: result.meta.totalCandidates,
        guilds: result.guilds,
        leftover: result.leftover,
      });
    } catch (historyErr) {
      console.error('[draft-proposal] Erreur sauvegarde historique (non bloquant):', historyErr.message);
    }
  } catch (error) {
    const status = error.statusCode || 500;
    if (status === 500) console.error('Erreur lors de la génération de la proposition de draft:', error);
    res.status(status).json({ success: false, message: error.message || 'Erreur serveur lors de la génération de la proposition de draft' });
  }
});

// GET historique des propositions générées (résumés, les plus récentes d'abord)
router.get('/draft-proposal/history', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const entries = await req.db.collection('draft_proposals')
      .find({}, { projection: { guilds: 0, leftover: 0 } })
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();
    res.json({ success: true, entries });
  } catch (error) {
    console.error('Erreur lors de la récupération de l\'historique des propositions:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur lors de la récupération de l\'historique' });
  }
});

// GET une entrée d'historique complète (avec le détail des guildes)
router.get('/draft-proposal/history/:id', requireAdmin, async (req, res) => {
  try {
    const entry = await req.db.collection('draft_proposals').findOne({ _id: new ObjectId(req.params.id) });
    if (!entry) {
      return res.status(404).json({ success: false, message: 'Entrée introuvable' });
    }
    res.json({ success: true, entry });
  } catch (error) {
    res.status(400).json({ success: false, message: 'Format d\'ID invalide' });
  }
});

// DELETE une entrée d'historique
router.delete('/draft-proposal/history/:id', requireAdmin, async (req, res) => {
  try {
    await req.db.collection('draft_proposals').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true, message: 'Entrée supprimée' });
  } catch (error) {
    res.status(400).json({ success: false, message: 'Format d\'ID invalide' });
  }
});

export default router;
