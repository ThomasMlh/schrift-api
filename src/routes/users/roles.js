import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, validateObjectIdParam } from '../../middleware/auth.js';
import { notifyDiscord } from '../../utils/notifyDiscord.js';
import { getUserDisplayName } from '../../utils/nameMatching.js';
import { upsertPrimaryAccount, deriveMirrorFields, findAccount, assertRoleAvailable, updateAccount } from '../../utils/bbsAccounts.js';
import { logger } from '../../utils/logger.js';
import { checkWaitlistPlaces } from '../../services/recruitment.js';
import { sendHiddenServiceError } from '../../utils/httpErrors.js';
import { notifyGuildChange } from './notifications.js';

const router = express.Router();

// PUT update a user's role (admin only).
// Optional bbs_id targets that account; defaults to the main account.
router.put('/:userId/role', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { role, bbs_id } = req.body;

    if (!role) {
      return res.status(400).json({ success: false, message: 'Le rôle est requis' });
    }

    let user;

    // Try a MongoDB ObjectId first, then a discord_id
    if (ObjectId.isValid(userId)) {
      user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    } else {
      user = await req.db.collection('users').findOne({ discord_id: userId });
    }

    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    const targetAccount = bbs_id
      ? findAccount(user, bbs_id)
      : (user.bbs_accounts || []).find(a => a.is_primary) || null;

    if (bbs_id && !targetAccount) {
      return res.status(404).json({ success: false, message: 'Compte bbs introuvable pour cet utilisateur' });
    }

    const guildeId = targetAccount?.guilde_id || null;

    if (!guildeId) {
      return res.status(400).json({
        success: false,
        message: 'Le compte doit être dans une guilde pour avoir un rôle'
      });
    }

    // Role constraints apply per account, not per user
    await assertRoleAvailable(req.db, guildeId, role, targetAccount?.bbs_id);

    const oldRole = targetAccount?.role || 'membre';

    const bbsAccounts = bbs_id
      ? updateAccount(user.bbs_accounts, bbs_id, { role })
      : upsertPrimaryAccount(user.bbs_accounts, {
          bbsId: targetAccount?.bbs_id, bbsName: targetAccount?.bbs_name, guildeId, role
        });

    const result = await req.db.collection('users').updateOne(
      { _id: user._id },
      { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    // Discord notification, awaited before responding: on Vercel (serverless) execution may stop once
    // the response is sent, so a call left running after res.json() is not guaranteed to complete.
    if (oldRole !== role) {
      try {
        const guilde = await req.db.collection('guildes').findOne({ _id: new ObjectId(guildeId) });
        await notifyDiscord('membre_role_change', {
          membre_name: targetAccount?.bbs_name || getUserDisplayName(user),
          guild_name: guilde?.name || '',
          old_role: oldRole,
          new_role: role
        }, guilde?.discord_channel_id || process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
      } catch (notifErr) {
        logger.error('[users/role] Erreur notification Discord (non bloquant):', notifErr.message);
      }
    }

    res.json({ success: true, message: `Rôle mis à jour vers ${role}` });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors de la mise à jour du rôle:');
  }
});

// PUT change a user's guild (admin only).
// Optional bbs_id targets that account; defaults to the main account.
router.put('/:userId/guild', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId } = req.params;
    const { guildeId, role, bbs_id } = req.body;

    if (!guildeId) {
      return res.status(400).json({ success: false, message: 'L\'ID de la guilde est requis' });
    }

    const newRole = role || 'membre';

    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    const targetAccount = bbs_id ? findAccount(user, bbs_id) : (user.bbs_accounts || []).find(a => a.is_primary) || null;
    if (bbs_id && !targetAccount) {
      return res.status(404).json({ success: false, message: 'Compte bbs introuvable pour cet utilisateur' });
    }

    // Role constraints apply per account, not per user
    if (newRole === 'chef' || newRole === 'sous-chef') {
      await assertRoleAvailable(req.db, guildeId, newRole, targetAccount?.bbs_id);
    }

    const bbsAccounts = bbs_id
      ? updateAccount(user.bbs_accounts, bbs_id, { guildeId, role: newRole })
      : upsertPrimaryAccount(user.bbs_accounts, {
          bbsId: targetAccount?.bbs_id, bbsName: targetAccount?.bbs_name, guildeId, role: newRole
        });

    await req.db.collection('users').updateOne(
      { _id: user._id },
      { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
    );

    // Discord notification, only relevant for the main account (what the root guilde_id/role fields
    // reflect), awaited before responding.
    if (!bbs_id || targetAccount?.is_primary) {
      await notifyGuildChange(req.db, user, guildeId).catch(e =>
        logger.error('[users/guild] Erreur notification Discord:', e.message)
      );
    }

    // A freed place may concern candidates on the waiting list
    await checkWaitlistPlaces(req.db);

    res.json({ success: true, message: `${getUserDisplayName(user, 'Utilisateur')} déplacé vers la nouvelle guilde` });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors du changement de guilde:');
  }
});

export default router;
