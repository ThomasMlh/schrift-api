import express from 'express';
import { ObjectId } from 'mongodb';
import { logger } from '../../utils/logger.js';
import { sendServerErrorWithFlag } from '../../utils/httpErrors.js';
import { CLEAR_SCORE_THRESHOLD } from '../../utils/scoreThresholds.js';

const router = express.Router();

// Classement de toutes les guildes pour un cycle
router.get('/rankings', async (req, res) => {
  try {
    const cycleId = req.query.cycle_id;

    const guildes = await req.db.collection('guildes').find({ disabled: { $ne: true } }).toArray();
    if (guildes.length === 0) return res.json({ success: true, data: [] });

    const guildIds = guildes.map(g => g._id.toString());
    const scoresQuery = { guild_id: { $in: guildIds } };
    if (cycleId) scoresQuery.cycle_id = cycleId;

    const allScores = await req.db.collection('scores').find(scoresQuery, { projection: { guild_id: 1, score: 1 } }).toArray();

    const scoresByGuild = {};
    for (const s of allScores) {
      if (!scoresByGuild[s.guild_id]) scoresByGuild[s.guild_id] = [];
      scoresByGuild[s.guild_id].push(s.score || 0);
    }

    // Nombre de comptes actuels par guilde (pour l'affichage) — un compte bbs = un membre du roster,
    // un même user peut donc compter pour plusieurs guildes s'il y a un compte dans chacune.
    const memberCountRows = await req.db.collection('users').aggregate([
      { $match: { "bbs_accounts.guilde_id": { $in: guildIds } } },
      { $unwind: "$bbs_accounts" },
      { $match: { "bbs_accounts.guilde_id": { $in: guildIds } } },
      { $group: { _id: "$bbs_accounts.guilde_id", count: { $sum: 1 } } }
    ]).toArray();
    const memberCountByGuild = Object.fromEntries(memberCountRows.map(r => [r._id, r.count]));

    const results = guildes.map(guild => {
      const guildId = guild._id.toString();
      const guildScores = scoresByGuild[guildId] || [];

      const totalScores = guildScores.length;
      const totalPoints = guildScores.reduce((s, v) => s + v, 0);
      const averageScore = totalScores > 0 ? Math.round(totalPoints / totalScores) : 0;
      const bestScore = totalScores > 0 ? Math.max(...guildScores) : 0;
      const clearCount = guildScores.filter(v => v >= CLEAR_SCORE_THRESHOLD).length;
      const clearRate = totalScores > 0 ? Math.round((clearCount / totalScores) * 10000) / 100 : 0;

      return { _id: guildId, name: guild.name, totalMembers: memberCountByGuild[guildId] || 0, averageScore, bestScore, totalScores, totalPoints, clearRate };
    });

    results.sort((a, b) => b.averageScore - a.averageScore);
    results.forEach((g, i) => { g.rank = i + 1; });

    res.json({ success: true, data: results });
  } catch (err) {
    logger.error('Error fetching guild rankings:', err);
    sendServerErrorWithFlag(res, err);
  }
});

// Nombre de membres par guilde (une seule requête via aggregation)
router.get('/members-summary', async (req, res) => {
  try {
    const guildIds = (await req.db.collection('guildes')
      .find({ disabled: { $ne: true } }, { projection: { _id: 1 } })
      .toArray()).map(g => g._id.toString());

    const rows = await req.db.collection('users').aggregate([
      { $match: { "bbs_accounts.guilde_id": { $in: guildIds } } },
      { $unwind: '$bbs_accounts' },
      { $match: { "bbs_accounts.guilde_id": { $in: guildIds } } },
      { $group: { _id: '$bbs_accounts.guilde_id', count: { $sum: 1 } } },
    ]).toArray();

    const data = Object.fromEntries(rows.map(r => [r._id, r.count]));
    res.json({ success: true, data });
  } catch (err) {
    sendServerErrorWithFlag(res, err);
  }
});

// Récupérer les statistiques d'une guilde
router.get('/:id/stats', async (req, res) => {
  try {
    const guildeId = req.params.id;
    const cycleId = req.query.cycle_id;

    // Vérifier que la guilde existe
    const guilde = await req.db.collection('guildes').findOne({ _id: new ObjectId(guildeId) });
    if (!guilde) {
      return res.status(404).json({ success: false, message: 'Guilde non trouvée' });
    }

    // Construire la requête pour les scores (basée sur guild_id dans le score)
    const scoresQuery = { guild_id: guildeId };
    if (cycleId) {
      scoresQuery.cycle_id = cycleId;
    }

    // Récupérer tous les scores de la guilde
    const scores = await req.db.collection('scores')
      .find(scoresQuery)
      .toArray();

    // Nombre de comptes actuels (pour l'affichage)
    const totalMembers = await req.db.collection('users').countDocuments({ "bbs_accounts.guilde_id": guildeId });

    // Calculer les statistiques
    const totalScores = scores.length;
    const totalPoints = scores.reduce((sum, score) => sum + (score.score || 0), 0);
    const averageScore = totalScores > 0 ? Math.round(totalPoints / totalScores) : 0;
    const bestScore = totalScores > 0 ? Math.max(...scores.map(s => s.score || 0)) : 0;
    const clearCount = scores.filter(s => (s.score || 0) >= CLEAR_SCORE_THRESHOLD).length;
    const clearRate = totalScores > 0 ? Math.round((clearCount / totalScores) * 100 * 100) / 100 : 0;

    const stats = {
      totalMembers,
      averageScore,
      totalScores,
      bestScore,
      totalPoints,
      clearRate
    };

    res.json({ success: true, data: stats });
  } catch (err) {
    logger.error('Error fetching guild stats:', err);
    sendServerErrorWithFlag(res, err);
  }
});

// Top membres d'une guilde pour un cycle
router.get('/:id/top-members', async (req, res) => {
  try {
    const cycleId = req.query.cycle_id;
    const limit = Math.min(parseInt(req.query.limit) || 3, 10);
    const guildeId = req.params.id;

    const scoresQuery = { guild_id: guildeId };
    if (cycleId) scoresQuery.cycle_id = cycleId;

    const scores = await req.db.collection('scores').find(scoresQuery, { projection: { user_id: 1, bbs_id: 1, bbs_name: 1, score: 1 } }).toArray();
    if (scores.length === 0) return res.json({ success: true, data: [] });

    // Groupé par compte bbs (pas par user) : deux comptes du même user comptent séparément.
    const byAccount = {};
    for (const s of scores) {
      const key = s.bbs_id || s.user_id;
      if (!byAccount[key]) byAccount[key] = { userId: s.user_id, bbsId: s.bbs_id, bbsName: s.bbs_name, scores: [] };
      byAccount[key].scores.push(s.score || 0);
    }

    // Récupérer les infos Discord des users concernés (actuels ou anciens), pour avatar/discord_id.
    const userIds = [...new Set(Object.values(byAccount).map(a => a.userId))];
    const membres = await req.db.collection('users').find(
      { _id: { $in: userIds.map(id => new ObjectId(id)) } },
      { projection: { _id: 1, discord_id: 1, global_name: 1, username: 1, avatar: 1 } }
    ).toArray();
    const memberMap = Object.fromEntries(membres.map(m => [m._id.toString(), m]));

    const topMembers = Object.values(byAccount).map(({ userId, bbsId, bbsName, scores: memberScores }) => {
      const user = memberMap[userId];
      const bestScore = Math.max(...memberScores);
      const avgScore = Math.round(memberScores.reduce((a, b) => a + b, 0) / memberScores.length);
      return {
        userId, bbsId,
        username: bbsName || user?.global_name || user?.username || 'Inconnu',
        bbs_name: bbsName, avatar: user?.avatar, discord_id: user?.discord_id,
        bestScore, avgScore, totalScores: memberScores.length
      };
    });

    topMembers.sort((a, b) => b.bestScore - a.bestScore);
    res.json({ success: true, data: topMembers.slice(0, limit) });
  } catch (err) {
    logger.error('Error fetching guild top members:', err);
    sendServerErrorWithFlag(res, err);
  }
});

// Distribution des scores d'une guilde pour un cycle
router.get('/:id/score-distribution', async (req, res) => {
  try {
    const cycleId = req.query.cycle_id;
    const guildeId = req.params.id;

    const scoresQuery = { guild_id: guildeId };
    if (cycleId) scoresQuery.cycle_id = cycleId;

    const scores = await req.db.collection('scores').find(scoresQuery, { projection: { score: 1 } }).toArray();

    const buckets = [
      { label: 'Miss', min: 0, max: 0, count: 0 },
      { label: '< 200M', min: 1, max: 200_000_000, count: 0 },
      { label: '200M–400M', min: 200_000_000, max: 400_000_000, count: 0 },
      { label: '400M–617M', min: 400_000_000, max: CLEAR_SCORE_THRESHOLD, count: 0 },
      { label: '≥ 617M', min: CLEAR_SCORE_THRESHOLD, max: Infinity, count: 0 },
    ];

    for (const s of scores) {
      const val = s.score || 0;
      if (val === 0) {
        buckets[0].count++;
      } else {
        const bucket = buckets.slice(1).find(b => val >= b.min && val < b.max);
        if (bucket) bucket.count++;
      }
    }

    res.json({ success: true, data: buckets.map(b => ({ label: b.label, count: b.count })) });
  } catch (err) {
    logger.error('Error fetching guild score distribution:', err);
    sendServerErrorWithFlag(res, err);
  }
});

// Évolution d'une guilde sur les derniers cycles
router.get('/:id/evolution', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 6, 12);
    const guildeId = req.params.id;

    const allCycles = await req.db.collection('cycles').find({}).toArray();

    const parseDate = (s) => {
      if (!s) return 0;
      const parts = s.split('/');
      if (parts.length !== 3) return 0;
      return new Date(parts[2], parts[1] - 1, parts[0]).getTime();
    };

    allCycles.sort((a, b) => parseDate(b.rotations?.[0]?.start_date) - parseDate(a.rotations?.[0]?.start_date));
    const recentCycles = allCycles.slice(0, limit).reverse();

    const cycleIds = recentCycles.map(c => c._id.toString());
    const allScores = await req.db.collection('scores').find(
      { guild_id: guildeId, cycle_id: { $in: cycleIds } },
      { projection: { cycle_id: 1, score: 1 } }
    ).toArray();

    const scoresByCycle = {};
    for (const s of allScores) {
      if (!scoresByCycle[s.cycle_id]) scoresByCycle[s.cycle_id] = [];
      scoresByCycle[s.cycle_id].push(s.score || 0);
    }

    const results = recentCycles.map(cycle => {
      const cycleId = cycle._id.toString();
      const cycleScores = scoresByCycle[cycleId] || [];
      const totalScores = cycleScores.length;
      const totalPoints = cycleScores.reduce((s, v) => s + v, 0);
      const averageScore = totalScores > 0 ? Math.round(totalPoints / totalScores) : 0;
      const clearCount = cycleScores.filter(v => v >= CLEAR_SCORE_THRESHOLD).length;
      const clearRate = totalScores > 0 ? Math.round((clearCount / totalScores) * 10000) / 100 : 0;
      return { cycleId, cycleName: cycle.name, cycleYear: cycle.year, averageScore, totalScores, clearRate };
    });

    res.json({ success: true, data: results });
  } catch (err) {
    logger.error('Error fetching guild evolution:', err);
    sendServerErrorWithFlag(res, err);
  }
});

export default router;
