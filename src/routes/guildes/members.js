import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin } from '../../middleware/auth.js';
import { getUserDisplayName } from '../../utils/nameMatching.js';
import { notifyDiscord } from '../../utils/notifyDiscord.js';
import {
  getGuildAccountRoster, findAccount, assertRoleAvailable,
  upsertPrimaryAccount, updateAccount, deriveMirrorFields
} from '../../utils/bbsAccounts.js';
import { logger } from '../../utils/logger.js';
import { sendServerError, sendStatusCodeError } from '../../utils/httpErrors.js';

const router = express.Router();

// GET a guild's members (bbs accounts). A user may appear more than once if several of their
// accounts are attached to this guild (unusual, but possible with alts).
router.get('/:id/membres', async (req, res) => {
  try {
    const guildeId = req.params.id;
    const roster = await getGuildAccountRoster(req.db, guildeId);
    res.json({ success: true, data: roster, count: roster.length });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST assign a user to a guild with a role.
// Optional bbs_id targets that account; defaults to the user's main account.
router.post('/:id/assign-member', requireAdmin, async (req, res) => {
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

    // Role constraints apply per account, not per user
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

    // Discord notification, awaited before responding.
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

// DELETE remove a member from a guild. Optional bbs_id (query) targets that account; defaults to
// the account attached to this guild (or the main account as a last resort).
router.delete('/:id/members/:userId', requireAdmin, async (req, res) => {
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

    // Discord notification, awaited before responding.
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

// DELETE remove a member from a guild (French path variant). Optional bbs_id (body) targets that account.
router.delete('/:guildeId/membres/:userId', requireAdmin, async (req, res) => {
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

    // Discord notification, awaited before responding.
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

// POST add a member to a guild by creating a full user (legacy admin path, rarely used)
router.post('/:id/membres', requireAdmin, async (req, res) => {
  try {
    const guildeId = req.params.id;
    const role = req.body.role || 'membre';
    const { discord_id, bbs_id, bbs_name } = req.body;

    // Is the member already in this guild through a bbs account?
    const existing = await req.db.collection('users').findOne({
      discord_id,
      "bbs_accounts.guilde_id": guildeId
    });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Le membre existe déjà dans cette guilde' });
    }

    // Role constraints apply per account, not per user
    await assertRoleAvailable(req.db, guildeId, role, bbs_id);

    const bbsAccounts = upsertPrimaryAccount([], { bbsId: bbs_id, bbsName: bbs_name, guildeId, role });
    const mirror = deriveMirrorFields(bbsAccounts);

    const membre = { ...req.body, bbs_accounts: bbsAccounts, ...mirror };
    await req.db.collection('users').insertOne(membre);

    // Discord notification, awaited before responding.
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
