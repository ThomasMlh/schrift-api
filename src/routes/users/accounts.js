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
import { sendHiddenServiceError } from '../../utils/httpErrors.js';
import { notifyAccountGuildMove, notifyAccountRoleChange } from './notifications.js';

const router = express.Router();

// --- Gestion des comptes bbs (principal + alts) d'un user ---

// POST ajouter un compte alt à un user (admin seulement)
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

    // Notification Discord — attendue avant la réponse.
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

// PUT modifier un compte bbs existant d'un user (admin seulement)
// bbs_id dans le body est optionnel : s'il est fourni et différent du :bbsId de l'URL, le compte
// est renommé (ex: faute de frappe à la création) et l'historique des scores de ce compte migre
// avec lui, pour que le classement/l'historique du joueur restent cohérents après correction.
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

    // Migrer l'historique des scores de ce compte vers le nouvel identifiant/pseudo
    if (isRenaming || bbs_name !== undefined) {
      const scoreUpdate = {};
      if (isRenaming) scoreUpdate.bbs_id = newBbsId;
      if (bbs_name !== undefined) scoreUpdate.bbs_name = bbs_name;
      await req.db.collection('scores').updateMany(
        { user_id: userId, bbs_id: bbsId },
        { $set: scoreUpdate }
      );
    }

    // L'album de personnages est indexé par bbs_id : il suit le compte renommé
    if (isRenaming) {
      await req.db.collection('albums').updateOne({ bbs_id: bbsId }, { $set: { bbs_id: newBbsId } });
    }

    // Notification Discord — guilde et/ou rôle du compte ont pu changer, attendue avant la réponse.
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

    res.json({ success: true, message: 'Compte bbs mis à jour avec succès', bbs_accounts: bbsAccounts });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors de la mise à jour du compte bbs:');
  }
});

// DELETE retirer un compte bbs d'un user (admin seulement)
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

    // Notification Discord — attendue avant la réponse.
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

    res.json({ success: true, message: 'Compte bbs retiré avec succès', bbs_accounts: bbsAccounts });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors du retrait du compte bbs:');
  }
});

// PUT définir un compte bbs comme principal (admin seulement)
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

// POST transférer un compte bbs d'un user vers un autre, en tant qu'alt (jamais principal chez la cible).
// N'affecte volontairement pas les scores existants : ils restent liés au bbs_id (déjà dénormalisé
// sur chaque score) et à l'ancien user_id — l'historique "suit" le compte via bbs_id, pas besoin de
// réécrire scores.user_id (cf. décision produit : peu importe quel user_id porte le score historique).
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

    // Retirer le compte du user source. S'il était principal et qu'il reste d'autres comptes,
    // en promouvoir un automatiquement pour ne pas laisser le user source sans compte principal.
    let sourceAccounts = sourceUser.bbs_accounts || [];
    if (account.is_primary) {
      const nextPrimary = sourceAccounts.find(a => a.bbs_id !== bbsId);
      if (nextPrimary) {
        sourceAccounts = setPrimaryAccount(sourceAccounts, nextPrimary.bbs_id);
      }
    }
    sourceAccounts = sourceAccounts.filter(a => a.bbs_id !== bbsId);

    // L'ajouter comme alt chez la cible (jamais principal), en conservant bbs_name/guilde/rôle du compte.
    // addAltAccount lève une erreur si ce bbs_id existe déjà chez la cible (ne devrait pas arriver).
    const targetAccounts = addAltAccount(targetUser.bbs_accounts, {
      bbsId: account.bbs_id,
      bbsName: account.bbs_name,
      guildeId: account.guilde_id,
      role: account.role
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
