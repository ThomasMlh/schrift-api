import express from 'express';
import { ObjectId } from 'mongodb';
import { getUserDisplayName } from '../../utils/nameMatching.js';
import { notifyDiscord } from '../../utils/notifyDiscord.js';
import {
  getGuildAccountRoster, findAccount, assertRoleAvailable,
  upsertPrimaryAccount, updateAccount, deriveMirrorFields
} from '../../utils/bbsAccounts.js';
import { logger } from '../../utils/logger.js';
import { sendServerError, sendStatusCodeError } from '../../utils/httpErrors.js';

const router = express.Router();

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

export default router;
