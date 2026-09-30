import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb, requireAdmin, requireScoresAccess } from '../middleware/auth.js';
import { getUserDisplayName } from '../utils/nameMatching.js';
import { notifyDiscord } from '../utils/notifyDiscord.js';
import { sanitizeDisabledTypes } from '../utils/notificationTypes.js';
import { USER_DISPLAY } from '../utils/projections.js';
import {
  getGuildAccountRoster, findAccount, assertRoleAvailable,
  upsertPrimaryAccount, updateAccount, deriveMirrorFields
} from '../utils/bbsAccounts.js';
import { logger } from '../utils/logger.js';
import { sendServerError, sendServerErrorWithFlag, sendStatusCodeError } from '../utils/httpErrors.js';

const router = express.Router();

// Middleware pour toutes les routes guildes
router.use(requireDb);

// Récupérer toutes les guildes
router.get('/', async (req, res) => {
  try {
    const includeDisabled = req.query.include_disabled === 'true';
    const filter = includeDisabled ? {} : { disabled: { $ne: true } };
    const guildes = await req.db.collection('guildes').find(filter).toArray();
    guildes.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.status(200).json(guildes);
  } catch (err) {
    sendServerError(res, err);
  }
});

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
      const clearCount = guildScores.filter(v => v >= 600_000_000).length;
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

// Récupérer une guilde par ID
router.get('/:id', async (req, res) => {
  try {
    const guilde = await req.db.collection('guildes').findOne({ _id: new ObjectId(req.params.id) });
    if (!guilde) {
      return res.status(404).json({ success: false, message: 'Guilde non trouvée' });
    }
    res.json(guilde);
  } catch (err) {
    sendServerError(res, err);
  }
});

// Récupérer les membres (comptes bbs) d'une guilde — un même user peut apparaître plusieurs fois
// s'il a plusieurs comptes rattachés à cette guilde (ce qui ne devrait pas arriver en pratique,
// une guilde n'ayant qu'un roster de jeu, mais reste possible si plusieurs alts y sont rattachés).
router.get('/:id/membres', async (req, res) => {
  try {
    const guildeId = req.params.id;
    const roster = await getGuildAccountRoster(req.db, guildeId);
    res.json({ success: true, data: roster, count: roster.length });
  } catch (err) {
    sendServerError(res, err);
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
    const clearCount = scores.filter(s => (s.score || 0) >= 600_000_000).length;
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
      { label: '400M–600M', min: 400_000_000, max: 600_000_000, count: 0 },
      { label: '≥ 600M', min: 600_000_000, max: Infinity, count: 0 },
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
      const clearCount = cycleScores.filter(v => v >= 600_000_000).length;
      const clearRate = totalScores > 0 ? Math.round((clearCount / totalScores) * 10000) / 100 : 0;
      return { cycleId, cycleName: cycle.name, cycleYear: cycle.year, averageScore, totalScores, clearRate };
    });

    res.json({ success: true, data: results });
  } catch (err) {
    logger.error('Error fetching guild evolution:', err);
    sendServerErrorWithFlag(res, err);
  }
});

// Ajouter une guilde
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: 'Le nom de la guilde est requis' });
    }

    // Vérifier si une guilde avec ce nom existe déjà
    const existingGuilde = await req.db.collection('guildes').findOne({
      name: { $regex: new RegExp(`^${name.trim()}$`, 'i') } // Insensible à la casse
    });

    if (existingGuilde) {
      return res.status(409).json({
        success: false,
        message: 'Une guilde avec ce nom existe déjà'
      });
    }

    const result = await req.db.collection('guildes').insertOne({
      ...req.body,
      name: name.trim() // Nettoyer le nom
    });

    // Notification Discord — attendue avant la réponse.
    try {
      await notifyDiscord('guild_change', {
        action: 'create',
        guild_name: name.trim()
      }, req.body.discord_channel_id || process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
    } catch (notifErr) {
      logger.error('[guildes/create] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.status(200).json({
      success: true,
      insertedId: result.insertedId,
      message: `Guilde ${name.trim()} ajoutée avec succès`
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Renommer une guilde
router.put('/:id', async (req, res) => {
  try {
    const { name } = req.body;
    const guildeId = req.params.id;

    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: 'Le nom de la guilde est requis' });
    }

    // Vérifier si une autre guilde avec ce nom existe déjà (excluant la guilde actuelle)
    const existingGuilde = await req.db.collection('guildes').findOne({
      name: { $regex: new RegExp(`^${name.trim()}$`, 'i') },
      _id: { $ne: new ObjectId(guildeId) }
    });

    if (existingGuilde) {
      return res.status(409).json({
        success: false,
        message: 'Une autre guilde avec ce nom existe déjà'
      });
    }

    const currentGuilde = await req.db.collection('guildes').findOne({ _id: new ObjectId(guildeId) });

    const updateFields = { name: name.trim() };
    const { discord_channel_id, discord_general_channel_id, disabled_notification_types } = req.body;
    if (discord_channel_id !== undefined) {
      updateFields.discord_channel_id = discord_channel_id;
    }
    if (discord_general_channel_id !== undefined) {
      updateFields.discord_general_channel_id = discord_general_channel_id;
    }
    if (disabled_notification_types !== undefined) {
      updateFields.disabled_notification_types = sanitizeDisabledTypes(disabled_notification_types);
    }

    await req.db.collection('guildes').updateOne(
      { _id: new ObjectId(guildeId) },
      { $set: updateFields }
    );

    // Notification Discord — attendue avant la réponse.
    if (currentGuilde && currentGuilde.name !== name.trim()) {
      try {
        await notifyDiscord('guild_change', {
          action: 'rename',
          old_name: currentGuilde.name,
          guild_name: name.trim()
        }, updateFields.discord_channel_id || currentGuilde.discord_channel_id || process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
      } catch (notifErr) {
        logger.error('[guildes/rename] Erreur notification Discord (non bloquant):', notifErr.message);
      }
    }

    res.status(200).json({ success: true, message: `Guilde renommée en ${name.trim()}` });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Envoie une notification de test au channel fourni (pas forcément celui déjà enregistré en
// base — sert à vérifier un ID de channel avant de sauvegarder). Contrairement à
// notifyDiscord() (non bloquant, jamais d'erreur remontée), on attend et on renvoie le
// résultat réel : c'est tout l'intérêt d'un bouton de test.
router.post('/:id/test-notification', requireScoresAccess, async (req, res) => {
  try {
    const guildeId = req.params.id;
    const { channel_id } = req.body;

    if (!channel_id || !channel_id.trim()) {
      return res.status(400).json({ success: false, message: 'channel_id requis' });
    }
    if (!req.user.hasFullAccess && !(req.user.allowedGuildIds || []).includes(guildeId)) {
      return res.status(403).json({ success: false, message: 'Accès refusé à cette guilde' });
    }

    const guilde = await req.db.collection('guildes').findOne({ _id: new ObjectId(guildeId) });
    if (!guilde) {
      return res.status(404).json({ success: false, message: 'Guilde introuvable' });
    }

    const botUrl = `${process.env.BOT_WEBHOOK_URL || 'http://localhost:8080'}/webhook`;
    const payload = {
      type: 'generic',
      channel: channel_id.trim(),
      data: {
        title: '🔔 Test de notification',
        message: `Ceci est un test envoyé depuis les paramètres de notification de la guilde **${guilde.name}**.`,
      },
    };

    const botResponse = await fetch(botUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!botResponse.ok) {
      const body = await botResponse.text().catch(() => '');
      return res.status(502).json({
        success: false,
        message: `Le bot a répondu ${botResponse.status}${body ? `: ${body.slice(0, 300)}` : ''}`
      });
    }

    res.json({ success: true, message: 'Notification de test envoyée' });
  } catch (err) {
    res.status(502).json({ success: false, message: `Impossible de joindre le bot: ${err.message}` });
  }
});

// Activer/Désactiver une guilde
router.patch('/:id/toggle-disable', requireAdmin, async (req, res) => {
  try {
    const guildeId = req.params.id;
    const guilde = await req.db.collection('guildes').findOne({ _id: new ObjectId(guildeId) });
    if (!guilde) {
      return res.status(404).json({ success: false, message: 'Guilde non trouvée' });
    }

    const newDisabledState = !guilde.disabled;

    // Si on désactive la guilde, retirer tous les membres (comptes bbs rattachés à cette guilde)
    if (newDisabledState) {
      const affectedUsers = await req.db.collection('users').find({ "bbs_accounts.guilde_id": guildeId }).toArray();
      for (const u of affectedUsers) {
        const clearedAccounts = (u.bbs_accounts || []).map(a =>
          a.guilde_id === guildeId ? { ...a, guilde_id: null, role: null } : a
        );
        await req.db.collection('users').updateOne(
          { _id: u._id },
          { $set: { bbs_accounts: clearedAccounts, ...deriveMirrorFields(clearedAccounts) } }
        );
      }
    }

    await req.db.collection('guildes').updateOne(
      { _id: new ObjectId(guildeId) },
      { $set: { disabled: newDisabledState } }
    );

    const action = newDisabledState ? 'désactivée' : 'réactivée';

    // Notification Discord — attendue avant la réponse.
    try {
      const toggler = await req.db.collection('users').findOne(
        { _id: new ObjectId(req.user._id) },
        { projection: USER_DISPLAY }
      );
      await notifyDiscord('guild_toggle', {
        action: newDisabledState ? 'disable' : 'enable',
        guild_name: guilde.name,
        toggled_by: getUserDisplayName(toggler),
        toggled_at: new Date().toISOString()
      }, guilde.discord_channel_id || process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
    } catch (notifErr) {
      logger.error('[guildes/toggle-disable] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.status(200).json({
      success: true,
      message: `Guilde ${guilde.name} ${action} avec succès`,
      disabled: newDisabledState
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Supprimer une guilde
router.delete('/:id', async (req, res) => {
  try {
    const guilde = await req.db.collection('guildes').findOne({ _id: new ObjectId(req.params.id) });
    if (!guilde) {
      return res.status(404).json({ success: false, message: 'Guilde non trouvée' });
    }

    await req.db.collection('guildes').deleteOne({ _id: new ObjectId(req.params.id) });

    // Notification Discord — attendue avant la réponse.
    try {
      await notifyDiscord('guild_change', {
        action: 'delete',
        guild_name: guilde.name
      }, guilde.discord_channel_id || process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
    } catch (notifErr) {
      logger.error('[guildes/delete] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.status(200).json({ success: true, message: `Guilde ${guilde.name} supprimée avec succès` });
  } catch (err) {
    sendServerError(res, err);
  }
});

// Assigner un utilisateur à une guilde avec un rôle
// bbs_id optionnel : cible ce compte précis ; par défaut, le compte principal du user.
router.post('/:id/assign-member', async (req, res) => {
  try {
    const guildeId = req.params.id;
    const { userId, role, bbs_id } = req.body;

    if (!userId || !role) {
      return res.status(400).json({
        success: false,
        message: 'userId et role sont requis'
      });
    }

    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    const targetAccount = bbs_id ? findAccount(user, bbs_id) : (user.bbs_accounts || []).find(a => a.is_primary) || null;
    if (bbs_id && !targetAccount) {
      return res.status(404).json({ success: false, message: 'Compte bbs introuvable pour cet utilisateur' });
    }

    // Vérifier les contraintes de rôle (au niveau des comptes, pas des users)
    await assertRoleAvailable(req.db, guildeId, role, targetAccount?.bbs_id);

    const bbsAccounts = bbs_id
      ? updateAccount(user.bbs_accounts, bbs_id, { guildeId, role })
      : upsertPrimaryAccount(user.bbs_accounts, {
          bbsId: targetAccount?.bbs_id, bbsName: targetAccount?.bbs_name, guildeId, role
        });

    await req.db.collection('users').updateOne(
      { _id: user._id },
      { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
    );

    // Notification Discord — attendue avant la réponse.
    try {
      const guilde = await req.db.collection('guildes').findOne({ _id: new ObjectId(guildeId) });
      await notifyDiscord('guild_member_change', {
        action: 'join',
        username: targetAccount?.bbs_name || getUserDisplayName(user),
        guild_name: guilde?.name || 'Inconnue',
        role
      }, guilde?.discord_channel_id || process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
    } catch (notifErr) {
      logger.error('[guildes/assign-member] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.json({ success: true, message: `${user.global_name || 'Utilisateur'} assigné à la guilde avec succès` });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status === 500) logger.error('Erreur lors de l\'assignation du membre:', err);
    res.status(status).json({ success: false, error: err.message, message: err.message });
  }
});

// Retirer un membre d'une guilde. bbs_id optionnel (query) : cible ce compte précis ;
// par défaut, le compte rattaché à cette guilde (ou le principal en dernier recours).
router.delete('/:id/members/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const guildeId = req.params.id;
    const bbsId = req.query.bbs_id;

    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    const targetAccount = bbsId
      ? findAccount(user, bbsId)
      : (user.bbs_accounts || []).find(a => a.guilde_id === guildeId) || (user.bbs_accounts || []).find(a => a.is_primary);

    if (!targetAccount) {
      return res.status(404).json({ success: false, message: 'Compte bbs introuvable pour cet utilisateur' });
    }

    const bbsAccounts = updateAccount(user.bbs_accounts, targetAccount.bbs_id, { guildeId: null, role: null });

    await req.db.collection('users').updateOne(
      { _id: user._id },
      { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
    );

    // Notification Discord — attendue avant la réponse.
    try {
      const guilde = await req.db.collection('guildes').findOne({ _id: new ObjectId(guildeId) });
      await notifyDiscord('guild_member_change', {
        action: 'leave',
        username: targetAccount.bbs_name || getUserDisplayName(user),
        guild_name: guilde?.name || 'Inconnue'
      }, guilde?.discord_channel_id || process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
    } catch (notifErr) {
      logger.error('[guildes/remove-member] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.json({ success: true, message: 'Utilisateur retiré de la guilde' });
  } catch (err) {
    const status = err.statusCode || 500;
    if (status === 500) logger.error(err);
    res.status(status).json({ success: false, error: err.message });
  }
});

// Retirer un membre d'une guilde (variante FR). bbs_id optionnel (body) : cible ce compte précis.
router.delete('/:guildeId/membres/:userId', async (req, res) => {
  try {
    const guildeId = req.params.guildeId;
    const userId = req.params.userId;
    const bbsId = req.body?.bbs_id || req.query.bbs_id;

    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé dans cette guilde'
      });
    }

    const targetAccount = bbsId
      ? findAccount(user, bbsId)
      : (user.bbs_accounts || []).find(a => a.guilde_id === guildeId);

    if (!targetAccount) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé dans cette guilde'
      });
    }

    const bbsAccounts = updateAccount(user.bbs_accounts, targetAccount.bbs_id, { guildeId: null, role: null });

    await req.db.collection('users').updateOne(
      { _id: user._id },
      { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
    );

    // Notification Discord — attendue avant la réponse.
    try {
      const guilde = await req.db.collection('guildes').findOne({ _id: new ObjectId(guildeId) });
      await notifyDiscord('guild_member_change', {
        action: 'leave',
        username: targetAccount.bbs_name || getUserDisplayName(user),
        guild_name: guilde?.name || 'Inconnue'
      }, guilde?.discord_channel_id || process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
    } catch (notifErr) {
      logger.error('[guildes/remove-membre] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.json({
      success: true,
      message: `${user.global_name || 'Utilisateur'} retiré de la guilde avec succès`
    });
  } catch (err) {
    logger.error('Erreur lors de la suppression du membre:', err);
    res.status(err.statusCode || 500).json({ success: false, message: err.message || 'Erreur serveur' });
  }
});

// Ajouter un membre à une guilde (création d'un user complet — legacy/admin, cas rare)
router.post('/:id/membres', async (req, res) => {
  try {
    const guildeId = req.params.id;
    const role = req.body.role || 'membre';
    const { discord_id, bbs_id, bbs_name } = req.body;

    // Vérifications si le membre existe déjà dans cette guilde via un compte bbs
    const existing = await req.db.collection('users').findOne({
      discord_id,
      "bbs_accounts.guilde_id": guildeId
    });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Le membre existe déjà dans cette guilde' });
    }

    // Vérification des contraintes de rôle (au niveau des comptes, pas des users)
    await assertRoleAvailable(req.db, guildeId, role, bbs_id);

    const bbsAccounts = upsertPrimaryAccount([], { bbsId: bbs_id, bbsName: bbs_name, guildeId, role });
    const mirror = deriveMirrorFields(bbsAccounts);

    const membre = { ...req.body, bbs_accounts: bbsAccounts, ...mirror };
    await req.db.collection('users').insertOne(membre);

    // Notification Discord — attendue avant la réponse.
    try {
      const guilde = await req.db.collection('guildes').findOne({ _id: new ObjectId(guildeId) });
      await notifyDiscord('guild_member_change', {
        action: 'join',
        username: mirror.bbs_name || 'Membre',
        guild_name: guilde?.name || 'Inconnue',
        role
      }, guilde?.discord_channel_id || process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
    } catch (notifErr) {
      logger.error('[guildes/add-membre] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.status(201).json({ success: true, message: `${mirror.bbs_name || 'Membre'} ajouté avec succès` });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur', 'Erreur lors de l\'ajout du membre:');
  }
});

// Exécuter un draft : retirer puis réassigner des joueurs en bulk
router.post('/draft', requireAdmin, async (req, res) => {
  try {
    const { moves } = req.body;

    if (!Array.isArray(moves) || moves.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Un tableau de mouvements est requis'
      });
    }

    // Valider chaque mouvement
    for (const move of moves) {
      if (!move.userId) {
        return res.status(400).json({
          success: false,
          message: 'Chaque mouvement doit contenir userId'
        });
      }
      if (!ObjectId.isValid(move.userId)) {
        return res.status(400).json({
          success: false,
          message: `ID utilisateur invalide: ${move.userId}`
        });
      }
      if (move.toGuildId && !ObjectId.isValid(move.toGuildId)) {
        return res.status(400).json({
          success: false,
          message: `ID guilde invalide: ${move.toGuildId}`
        });
      }
    }

    // Vérifier que toutes les guildes cibles existent (hors retraits)
    const targetGuildIds = [...new Set(moves.filter(m => m.toGuildId).map(m => m.toGuildId))];
    let guilds = [];
    if (targetGuildIds.length > 0) {
      guilds = await req.db.collection('guildes').find({
        _id: { $in: targetGuildIds.map(id => new ObjectId(id)) }
      }).toArray();

      if (guilds.length !== targetGuildIds.length) {
        return res.status(400).json({
          success: false,
          message: 'Une ou plusieurs guildes cibles n\'existent pas'
        });
      }
    }

    // Vérifier que tous les utilisateurs existent
    const userIds = moves.map(m => m.userId);
    const users = await req.db.collection('users').find({
      _id: { $in: userIds.map(id => new ObjectId(id)) }
    }).toArray();

    if (users.length !== userIds.length) {
      return res.status(400).json({
        success: false,
        message: 'Un ou plusieurs utilisateurs n\'existent pas'
      });
    }
    const userMap = new Map(users.map(u => [u._id.toString(), u]));

    // Résoudre, pour chaque mouvement, le compte bbs concerné (bbsId fourni, sinon le compte
    // principal) et mémoriser son état d'origine (guilde/rôle) pour le rollback et les notifs.
    const resolvedMoves = [];
    for (const move of moves) {
      const user = userMap.get(move.userId);
      const account = move.bbsId
        ? findAccount(user, move.bbsId)
        : (user.bbs_accounts || []).find(a => a.is_primary) || null;

      if (move.bbsId && !account) {
        return res.status(400).json({ success: false, message: `Compte bbs ${move.bbsId} introuvable pour ${move.userId}` });
      }

      resolvedMoves.push({
        ...move,
        bbsId: account?.bbs_id || null,
        originalGuildeId: account?.guilde_id || null,
        originalRole: account?.role || null,
        bbsName: account?.bbs_name || null
      });
    }

    // Étape 1 : Retirer chaque compte concerné de sa guilde
    for (const move of resolvedMoves) {
      const user = userMap.get(move.userId);
      const bbsAccounts = move.bbsId
        ? updateAccount(user.bbs_accounts, move.bbsId, { guildeId: null, role: null })
        : upsertPrimaryAccount(user.bbs_accounts, { guildeId: null, role: null });
      user.bbs_accounts = bbsAccounts;
      await req.db.collection('users').updateOne(
        { _id: user._id },
        { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
      );
    }

    // Étape 2 : Calculer les effectifs finaux par guilde (comptes, pas users) pour vérifier la limite de 20
    const guildCounts = {};
    for (const guildId of targetGuildIds) {
      const rows = await req.db.collection('users').aggregate([
        { $match: { "bbs_accounts.guilde_id": guildId } },
        { $unwind: "$bbs_accounts" },
        { $match: { "bbs_accounts.guilde_id": guildId } },
        { $count: "count" }
      ]).toArray();
      guildCounts[guildId] = rows[0]?.count || 0;
    }

    // Vérifier que chaque guilde ne dépassera pas 20 membres (ignorer les retraits)
    for (const move of resolvedMoves) {
      if (!move.toGuildId) continue;
      guildCounts[move.toGuildId] = (guildCounts[move.toGuildId] || 0) + 1;
      if (guildCounts[move.toGuildId] > 20) {
        // Rollback : remettre chaque compte dans sa guilde/rôle d'origine
        for (const m of resolvedMoves) {
          if (!m.bbsId || !m.originalGuildeId) continue;
          const user = userMap.get(m.userId);
          const bbsAccounts = updateAccount(user.bbs_accounts, m.bbsId, { guildeId: m.originalGuildeId, role: m.originalRole });
          user.bbs_accounts = bbsAccounts;
          await req.db.collection('users').updateOne(
            { _id: user._id },
            { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
          );
        }
        const guildName = guilds.find(g => g._id.toString() === move.toGuildId)?.name || move.toGuildId;
        return res.status(400).json({
          success: false,
          message: `La guilde ${guildName} dépasserait la limite de 20 membres`
        });
      }
    }

    // Étape 3 : Réassigner chaque compte dans sa nouvelle guilde (ou laisser sans guilde)
    const results = [];
    for (const move of resolvedMoves) {
      const user = userMap.get(move.userId);
      if (move.toGuildId) {
        const role = move.role || 'membre';
        const bbsAccounts = move.bbsId
          ? updateAccount(user.bbs_accounts, move.bbsId, { guildeId: move.toGuildId, role })
          : upsertPrimaryAccount(user.bbs_accounts, { guildeId: move.toGuildId, role });
        user.bbs_accounts = bbsAccounts;
        await req.db.collection('users').updateOne(
          { _id: user._id },
          { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
        );
      }
      // Si toGuildId est null, le compte reste sans guilde (déjà retiré à l'étape 1)
      results.push({
        userId: move.userId,
        username: move.bbsName || getUserDisplayName(user),
        toGuildId: move.toGuildId || null,
        toGuildName: move.toGuildId
          ? (guilds.find(g => g._id.toString() === move.toGuildId)?.name || 'Inconnue')
          : 'Aucune guilde'
      });
    }

    // Notifications Discord par guilde concernée — attendues avant la réponse.
    try {
      // Récupérer les guildes sources (pas forcément dans `guilds` qui ne contient que les cibles)
      const sourceGuildeIds = [...new Set(resolvedMoves.map(m => m.originalGuildeId).filter(Boolean))];
      const missingIds = sourceGuildeIds.filter(id => !guilds.find(g => g._id.toString() === id));
      const allGuildes = [...guilds];
      if (missingIds.length > 0) {
        const sourceGuildes = await req.db.collection('guildes').find({
          _id: { $in: missingIds.map(id => new ObjectId(id)) }
        }).toArray();
        allGuildes.push(...sourceGuildes);
      }

      const guildeMap = {};
      for (const g of allGuildes) {
        guildeMap[g._id.toString()] = { name: g.name, discord_channel_id: g.discord_channel_id, moves: [] };
      }

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const move = resolvedMoves[i];
        const fromGuildeId = move.originalGuildeId;
        const toGuildeId = result.toGuildId;

        const fromGuildName = fromGuildeId ? (guildeMap[fromGuildeId]?.name || 'Guilde inconnue') : 'Aucune guilde';
        const toGuildName = toGuildeId ? (guildeMap[toGuildeId]?.name || 'Guilde inconnue') : 'Aucune guilde';

        if (fromGuildeId && guildeMap[fromGuildeId]) {
          guildeMap[fromGuildeId].moves.push({
            username: result.username,
            fromGuildName,
            toGuildName,
            direction: 'départ',
          });
        }
        if (toGuildeId && guildeMap[toGuildeId]) {
          guildeMap[toGuildeId].moves.push({
            username: result.username,
            fromGuildName,
            toGuildName,
            direction: 'arrivée',
          });
        }
      }

      await Promise.allSettled(
        Object.values(guildeMap)
          .filter(g => g.moves.length > 0)
          .map(g => notifyDiscord('draft', { guild_name: g.name, moves: g.moves }, g.discord_channel_id || undefined))
      );
    } catch (notifErr) {
      logger.error('[draft] Erreur lors des notifications Discord:', notifErr.message);
    }

    res.json({
      success: true,
      message: `${moves.length} joueur(s) déplacé(s) avec succès`,
      results
    });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors du draft', 'Erreur lors de l\'exécution du draft:');
  }
});

export default router;