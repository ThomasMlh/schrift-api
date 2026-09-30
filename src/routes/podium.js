import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb, requireAdmin } from '../middleware/auth.js';
import { getPodium, getPodiumFull, getPodiumWeekly, getPodiumMisses, getDraftProposal } from '../services/podiumService.js';
import { getUserDisplayName } from '../utils/nameMatching.js';
import { USER_DISPLAY } from '../utils/projections.js';
import { notifyDiscord } from '../utils/notifyDiscord.js';
import { logger } from '../utils/logger.js';
import { sendStatusCodeError } from '../utils/httpErrors.js';

const router = express.Router();

router.use(requireDb);

// GET podium simple (top 10)
router.get('/', async (req, res) => {
  try {
    const result = await getPodium(req.db, req.query);
    res.json({ success: true, ...result });
  } catch (error) {
    sendStatusCodeError(res, error, 'Erreur serveur lors de la creation du podium');
  }
});

// GET podium complet pagine
router.get('/full', async (req, res) => {
  try {
    const result = await getPodiumFull(req.db, req.query);
    res.json({ success: true, ...result });
  } catch (error) {
    sendStatusCodeError(res, error, 'Erreur serveur lors de la creation du podium complet');
  }
});

// GET podium hebdomadaire
router.get('/weekly', async (req, res) => {
  try {
    const result = await getPodiumWeekly(req.db, req.query);
    res.json({ success: true, ...result });
  } catch (error) {
    sendStatusCodeError(res, error, 'Erreur serveur lors de la creation du podium hebdomadaire');
  }
});

// GET podium des miss
router.get('/misses', async (req, res) => {
  try {
    const result = await getPodiumMisses(req.db, req.query);
    res.json({ success: true, ...result });
  } catch (error) {
    sendStatusCodeError(res, error, 'Erreur serveur lors de la creation du podium des miss');
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
      logger.error('[draft-proposal] Erreur sauvegarde historique (non bloquant):', historyErr.message);
    }
  } catch (error) {
    sendStatusCodeError(res, error, 'Erreur serveur lors de la génération de la proposition de draft');
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
    logger.error('Erreur lors de la récupération de l\'historique des propositions:', error);
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

// POST publication manuelle d'un récap de podium de fin de cycle (capture d'écran), envoyé au
// salon général de la/les guilde(s) concernée(s). Réutilise l'infra podium_snapshot déjà en
// place pour les rotations (même type de notification côté bot), déclenché ici à la main par
// un admin plutôt qu'automatiquement après une saisie de scores.
router.post('/publish-cycle-recap', requireAdmin, async (req, res) => {
  try {
    const { cycle_name, year, ranking_type = 'average', guild_name } = req.body;

    if (!cycle_name) {
      return res.status(400).json({ success: false, message: 'cycle_name requis' });
    }
    if (!process.env.FRONTEND_URL) {
      return res.status(500).json({ success: false, message: 'FRONTEND_URL non configuré côté serveur' });
    }

    const cycleQuery = { name: cycle_name };
    if (year) cycleQuery.year = parseInt(year, 10);
    const cycle = await req.db.collection('cycles').findOne(cycleQuery, { sort: { created_at: -1 } });
    if (!cycle) {
      return res.status(404).json({ success: false, message: `Cycle "${cycle_name}" non trouvé` });
    }

    const guildQuery = guild_name ? { name: guild_name } : { disabled: { $ne: true } };
    const targetGuilds = await req.db.collection('guildes').find(guildQuery).toArray();
    if (targetGuilds.length === 0) {
      return res.status(404).json({ success: false, message: 'Aucune guilde correspondante' });
    }

    const cycleSlug = `${(cycle.name || '').toLowerCase().replace(/\s+/g, '-')}-${cycle.year}`;
    // Attendues avant la réponse (Promise.all) : sur Vercel (serverless), l'exécution peut être
    // coupée dès la réponse envoyée, donc des appels non attendus ne sont pas garantis d'aboutir.
    const results = await Promise.all(targetGuilds.map(async guild => {
      const channelId = guild.discord_general_channel_id || guild.discord_channel_id;
      if (!channelId) {
        return { guild: guild.name, status: 'skipped', reason: 'Aucun salon Discord configuré' };
      }

      const captureUrl = `${process.env.FRONTEND_URL.replace(/\/$/, '')}/podium?capture=1&mode=cycle`
        + `&ranking_type=${encodeURIComponent(ranking_type)}&cycle_name=${encodeURIComponent(cycleSlug)}`
        + `&guild_name=${encodeURIComponent(guild.name)}`;

      await notifyDiscord('podium_snapshot', {
        guild_name: guild.name,
        cycle_name: cycle.name,
        podium_url: captureUrl,
      }, channelId);

      return { guild: guild.name, status: 'requested' };
    }));

    res.json({ success: true, results });
  } catch (err) {
    logger.error('Erreur publication récap de cycle:', err);
    res.status(500).json({ success: false, message: 'Erreur serveur lors de la publication du récap' });
  }
});

export default router;
