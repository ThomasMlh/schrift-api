import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb, requireAdmin } from '../middleware/auth.js';
import { getPodium, getPodiumFull, getPodiumWeekly, getPodiumMonthly, getPodiumMonths, getPlayerMonthlyAverages, getMonthlyWinners, getPodiumMisses, getDraftProposal, getDraftReplacement } from '../services/podiumService/index.js';
import { getUserDisplayName } from '../utils/nameMatching.js';
import { USER_DISPLAY } from '../utils/projections.js';
import { publishCycleRecap, getCycleRecap } from '../services/cycleRecap.js';
import { logger } from '../utils/logger.js';
import { sendStatusCodeError } from '../utils/httpErrors.js';

const router = express.Router();

router.use(requireDb);

// GET podium (top 10)
router.get('/', async (req, res) => {
  try {
    const result = await getPodium(req.db, req.query);
    res.json({ success: true, ...result });
  } catch (error) {
    sendStatusCodeError(res, error, 'Erreur serveur lors de la creation du podium');
  }
});

// GET full paginated podium
router.get('/full', async (req, res) => {
  try {
    const result = await getPodiumFull(req.db, req.query);
    res.json({ success: true, ...result });
  } catch (error) {
    sendStatusCodeError(res, error, 'Erreur serveur lors de la creation du podium complet');
  }
});

// GET weekly podium
router.get('/weekly', async (req, res) => {
  try {
    const result = await getPodiumWeekly(req.db, req.query);
    res.json({ success: true, ...result });
  } catch (error) {
    sendStatusCodeError(res, error, 'Erreur serveur lors de la creation du podium hebdomadaire');
  }
});

// GET months available for the monthly podium
router.get('/months', async (req, res) => {
  try {
    const result = await getPodiumMonths(req.db);
    res.json({ success: true, ...result });
  } catch (error) {
    sendStatusCodeError(res, error, 'Erreur serveur lors de la récupération des mois');
  }
});

// GET winners of every finished month (top 3 players and best guild)
router.get('/monthly/winners', async (req, res) => {
  try {
    res.json({ success: true, months: await getMonthlyWinners(req.db) });
  } catch (error) {
    sendStatusCodeError(res, error, 'Erreur serveur lors du calcul du palmarès mensuel');
  }
});

// GET a bbs account's average per month
router.get('/monthly/player/:bbsId', async (req, res) => {
  try {
    res.json({ success: true, months: await getPlayerMonthlyAverages(req.db, req.params.bbsId) });
  } catch (error) {
    sendStatusCodeError(res, error, 'Erreur serveur lors du calcul des moyennes mensuelles');
  }
});

// GET monthly podium
router.get('/monthly', async (req, res) => {
  try {
    const result = await getPodiumMonthly(req.db, req.query);
    res.json({ success: true, ...result });
  } catch (error) {
    sendStatusCodeError(res, error, 'Erreur serveur lors de la creation du podium mensuel');
  }
});

// GET misses podium
router.get('/misses', async (req, res) => {
  try {
    const result = await getPodiumMisses(req.db, req.query);
    res.json({ success: true, ...result });
  } catch (error) {
    sendStatusCodeError(res, error, 'Erreur serveur lors de la creation du podium des miss');
  }
});

// GET draft proposal (admin): simulated split by score on a cycle
router.get('/draft-proposal', requireAdmin, async (req, res) => {
  try {
    const result = await getDraftProposal(req.db, req.query);
    res.json({ success: true, ...result });
    // Live views of the admin page recompute on every change: only explicit generations are kept
    if (req.query.preview === '1') return;

    // History (non-blocking, after the response): keeps the full generated result so it can be
    // reviewed later without recomputing it.
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
        locked_guild_names: result.meta.lockedGuilds,
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

// GET targeted replacement (admin): equivalent or stronger replacements for some players of a
// guild, taken from lower guilds in the order or from guildless players
router.get('/draft-replacement', requireAdmin, async (req, res) => {
  try {
    const result = await getDraftReplacement(req.db, req.query);
    res.json({ success: true, ...result });
  } catch (error) {
    sendStatusCodeError(res, error, 'Erreur serveur lors de la recherche de remplaçants');
  }
});

// GET generated proposals history (summaries, most recent first)
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

// GET a full history entry (with guild details)
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

// DELETE a history entry
router.delete('/draft-proposal/history/:id', requireAdmin, async (req, res) => {
  try {
    await req.db.collection('draft_proposals').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true, message: 'Entrée supprimée' });
  } catch (error) {
    res.status(400).json({ success: false, message: 'Format d\'ID invalide' });
  }
});

// POST publish the end-of-cycle recap manually to the general channel of the targeted guild(s):
// podium capture (same podium_snapshot notification as rotations) and/or written summary (top 3,
// records beaten, biggest progression, guild average).
router.post('/publish-cycle-recap', requireAdmin, async (req, res) => {
  try {
    const { cycle_name, year, ranking_type = 'average', guild_name, include_snapshot = true, include_summary = true } = req.body;

    if (!cycle_name) {
      return res.status(400).json({ success: false, message: 'cycle_name requis' });
    }
    if (!include_snapshot && !include_summary) {
      return res.status(400).json({ success: false, message: 'Rien à publier : capture et bilan désactivés' });
    }
    if (include_snapshot && !process.env.FRONTEND_URL) {
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

    const results = await publishCycleRecap(req.db, cycle, targetGuilds, {
      rankingType: ranking_type,
      includeSnapshot: !!include_snapshot,
      includeSummary: !!include_summary,
    });
    res.json({ success: true, results });
  } catch (err) {
    logger.error('Erreur publication récap de cycle:', err);
    res.status(500).json({ success: false, message: 'Erreur serveur lors de la publication du récap' });
  }
});

// GET preview of a guild's end-of-cycle recap (nothing is sent)
router.get('/cycle-recap', requireAdmin, async (req, res) => {
  try {
    const { cycle_id, guild_id } = req.query;
    if (!ObjectId.isValid(cycle_id) || !ObjectId.isValid(guild_id)) {
      return res.status(400).json({ success: false, message: 'cycle_id et guild_id valides requis' });
    }
    const [cycle, guild] = await Promise.all([
      req.db.collection('cycles').findOne({ _id: new ObjectId(cycle_id) }),
      req.db.collection('guildes').findOne({ _id: new ObjectId(guild_id) }),
    ]);
    if (!cycle || !guild) {
      return res.status(404).json({ success: false, message: 'Cycle ou guilde introuvable' });
    }
    res.json({ success: true, recap: await getCycleRecap(req.db, cycle, guild) });
  } catch (err) {
    logger.error('Erreur aperçu récap de cycle:', err);
    res.status(500).json({ success: false, message: 'Erreur serveur lors du calcul du récap' });
  }
});

export default router;
