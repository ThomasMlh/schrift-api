import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, validateObjectIdParam } from '../../middleware/auth.js';
import { getUserDisplayName } from '../../utils/nameMatching.js';
import {
  deriveMirrorFields, findAccount, assertRoleAvailable,
  addAltAccount, updateAccount, removeAccount, setPrimaryAccount,
  renameAccountBbsId, assertBbsIdAvailable
} from '../../utils/bbsAccounts.js';
import { logger } from '../../utils/logger.js';
import { checkWaitlistPlaces } from '../../services/recruitment.js';
import { sendHiddenServiceError } from '../../utils/httpErrors.js';
import { notifyAccountGuildMove, notifyAccountRoleChange } from './notifications.js';

const router = express.Router();


// POST add an alt account to a user (admin only)
router.post('/:userId/accounts', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId } = req.params;
    const { bbs_id, bbs_name, guilde_id, role } = req.body;

    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    if (bbs_id) {
      await assertBbsIdAvailable(req.db, bbs_id, userId);
    }

    if ((role === 'chef' || role === 'sous-chef') && guilde_id) {
      await assertRoleAvailable(req.db, guilde_id, role, bbs_id);
    }

    const bbsAccounts = addAltAccount(user.bbs_accounts, { bbsId: bbs_id, bbsName: bbs_name, guildeId: guilde_id, role });

    await req.db.collection('users').updateOne(
      { _id: user._id },
      { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
    );

    // Discord notification, awaited before responding.
    if (guilde_id) {
      try {
        await notifyAccountGuildMove(req.db, {
          username: bbs_name || getUserDisplayName(user),
          oldGuildeId: null,
          newGuildeId: guilde_id,
          role
        });
      } catch (notifErr) {
        logger.error('[users/accounts POST] Erreur notification Discord (non bloquant):', notifErr.message);
      }
    }

    res.status(201).json({ success: true, message: 'Compte bbs ajouté avec succès', bbs_accounts: bbsAccounts });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors de l\'ajout du compte bbs:');
  }
});

// PUT update a user's bbs account (admin only).
// The optional body bbs_id, when different from the URL :bbsId, renames the account (e.g. a typo at
// creation) and moves its score history along, so the player's ranking and history stay consistent.
router.put('/:userId/accounts/:bbsId', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId, bbsId } = req.params;
    const { bbs_id: newBbsId, bbs_name, guilde_id, role } = req.body;

    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    const accountBefore = findAccount(user, bbsId);

    if (role === 'chef' || role === 'sous-chef') {
      const targetGuildeId = guilde_id !== undefined ? guilde_id : accountBefore?.guilde_id;
      await assertRoleAvailable(req.db, targetGuildeId, role, bbsId);
    }

    const isRenaming = !!newBbsId && newBbsId !== bbsId;
    let bbsAccounts = user.bbs_accounts;

    if (isRenaming) {
      await assertBbsIdAvailable(req.db, newBbsId, userId);
      bbsAccounts = renameAccountBbsId(bbsAccounts, bbsId, newBbsId);
    }

    bbsAccounts = updateAccount(bbsAccounts, isRenaming ? newBbsId : bbsId, { bbsName: bbs_name, guildeId: guilde_id, role });

    await req.db.collection('users').updateOne(
      { _id: user._id },
      { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
    );

    // Move the account's score history to the new id/name
    if (isRenaming || bbs_name !== undefined) {
      const scoreUpdate = {};
      if (isRenaming) scoreUpdate.bbs_id = newBbsId;
      if (bbs_name !== undefined) scoreUpdate.bbs_name = bbs_name;
      await req.db.collection('scores').updateMany(
        { user_id: userId, bbs_id: bbsId },
        { $set: scoreUpdate }
      );
    }

    // Character albums are keyed by bbs_id: the album follows the renamed account
    if (isRenaming) {
      await req.db.collection('albums').updateOne({ bbs_id: bbsId }, { $set: { bbs_id: newBbsId } });
    }

    // Discord notification (the account's guild and/or role may have changed), awaited before responding.
    try {
      const oldGuildeId = accountBefore?.guilde_id || null;
      const oldRole = accountBefore?.role || null;
      const newGuildeId = guilde_id !== undefined ? (guilde_id || null) : oldGuildeId;
      const newRole = role !== undefined ? role : oldRole;
      const username = (bbs_name !== undefined ? bbs_name : accountBefore?.bbs_name) || getUserDisplayName(user);

      if (newGuildeId !== oldGuildeId) {
        await notifyAccountGuildMove(req.db, { username, oldGuildeId, newGuildeId, role: newRole });
      } else if (newRole !== oldRole) {
        await notifyAccountRoleChange(req.db, { username, guildeId: newGuildeId, oldRole, newRole });
      }
    } catch (notifErr) {
      logger.error('[users/accounts PUT] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    // A freed place may concern candidates on the waiting list
    await checkWaitlistPlaces(req.db);

    res.json({ success: true, message: 'Compte bbs mis à jour avec succès', bbs_accounts: bbsAccounts });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors de la mise à jour du compte bbs:');
  }
});

// DELETE remove a bbs account from a user (admin only)
router.delete('/:userId/accounts/:bbsId', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId, bbsId } = req.params;

    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    const accountBefore = findAccount(user, bbsId);
    const bbsAccounts = removeAccount(user.bbs_accounts, bbsId);

    await req.db.collection('users').updateOne(
      { _id: user._id },
      { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
    );

    // Discord notification, awaited before responding.
    if (accountBefore?.guilde_id) {
      try {
        await notifyAccountGuildMove(req.db, {
          username: accountBefore.bbs_name || getUserDisplayName(user),
          oldGuildeId: accountBefore.guilde_id,
          newGuildeId: null
        });
      } catch (notifErr) {
        logger.error('[users/accounts DELETE] Erreur notification Discord (non bloquant):', notifErr.message);
      }
    }

    // A freed place may concern candidates on the waiting list
    await checkWaitlistPlaces(req.db);

    res.json({ success: true, message: 'Compte bbs retiré avec succès', bbs_accounts: bbsAccounts });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors du retrait du compte bbs:');
  }
});

// PUT make a bbs account the main one (admin only)
router.put('/:userId/accounts/:bbsId/primary', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId, bbsId } = req.params;

    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    const bbsAccounts = setPrimaryAccount(user.bbs_accounts, bbsId);

    await req.db.collection('users').updateOne(
      { _id: user._id },
      { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
    );

    res.json({ success: true, message: 'Compte principal mis à jour avec succès', bbs_accounts: bbsAccounts });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors du changement de compte principal:');
  }
});

// POST transfer a bbs account from one user to another, as an alt (never the target's main account).
// Existing scores are intentionally left untouched: they stay linked to the bbs_id stored on each
// score and to the previous user_id; the history follows the account through bbs_id.
router.post('/:userId/accounts/:bbsId/transfer', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId, bbsId } = req.params;
    const { target_user_id } = req.body;

    if (!target_user_id || !ObjectId.isValid(target_user_id)) {
      return res.status(400).json({ success: false, message: 'target_user_id valide requis' });
    }
    if (target_user_id === userId) {
      return res.status(400).json({ success: false, message: "L'utilisateur cible doit être différent de l'utilisateur source" });
    }

    const sourceUser = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!sourceUser) {
      return res.status(404).json({ success: false, message: 'Utilisateur source non trouvé' });
    }

    const account = findAccount(sourceUser, bbsId);
    if (!account) {
      return res.status(404).json({ success: false, message: 'Compte bbs introuvable pour cet utilisateur' });
    }

    const targetUser = await req.db.collection('users').findOne({ _id: new ObjectId(target_user_id) });
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'Utilisateur cible non trouvé' });
    }

    // Remove the account from the source user. If it was the main account and others remain, promote
    // one automatically so the source user keeps a main account.
    let sourceAccounts = sourceUser.bbs_accounts || [];
    if (account.is_primary) {
      const nextPrimary = sourceAccounts.find(a => a.bbs_id !== bbsId);
      if (nextPrimary) {
        sourceAccounts = setPrimaryAccount(sourceAccounts, nextPrimary.bbs_id);
      }
    }
    sourceAccounts = sourceAccounts.filter(a => a.bbs_id !== bbsId);

    // Add it to the target as an alt (never main), keeping its bbs_name/guild/role and join date.
    // addAltAccount throws if the target already has this bbs_id (should not happen).
    const targetAccounts = addAltAccount(targetUser.bbs_accounts, {
      bbsId: account.bbs_id,
      bbsName: account.bbs_name,
      guildeId: account.guilde_id,
      role: account.role,
      guildJoinedAt: account.guild_joined_at ?? null
    });

    await req.db.collection('users').updateOne(
      { _id: sourceUser._id },
      { $set: { bbs_accounts: sourceAccounts, ...deriveMirrorFields(sourceAccounts) } }
    );
    await req.db.collection('users').updateOne(
      { _id: targetUser._id },
      { $set: { bbs_accounts: targetAccounts, ...deriveMirrorFields(targetAccounts) } }
    );

    res.json({
      success: true,
      message: `Compte ${account.bbs_name || bbsId} transféré avec succès`,
      source: { bbs_accounts: sourceAccounts },
      target: { bbs_accounts: targetAccounts }
    });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors du transfert de compte:');
  }
});

export default router;
