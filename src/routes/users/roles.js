import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, validateObjectIdParam } from '../../middleware/auth.js';
import { notifyDiscord } from '../../utils/notifyDiscord.js';
import { getUserDisplayName } from '../../utils/nameMatching.js';
import { upsertPrimaryAccount, deriveMirrorFields, findAccount, assertRoleAvailable, updateAccount } from '../../utils/bbsAccounts.js';
import { logger } from '../../utils/logger.js';
import { sendHiddenServiceError } from '../../utils/httpErrors.js';
import { notifyGuildChange } from './notifications.js';

const router = express.Router();

// Route pour mettre à jour le rôle d'un utilisateur (admin seulement)
// bbs_id optionnel : cible ce compte précis ; par défaut, le compte principal.
router.put('/:userId/role', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { role, bbs_id } = req.body;

    if (!role) {
      return res.status(400).json({ success: false, message: 'Le rôle est requis' });
    }

    // Récupérer l'utilisateur pour connaître sa guilde
    let user;

    // Essayer d'abord comme ObjectId MongoDB, sinon comme discord_id
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

    // Vérifier les contraintes de rôle (au niveau des comptes, pas des users)
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

    // Notification Discord — attendue avant la réponse : sur Vercel (serverless), l'exécution
    // peut être coupée dès la réponse envoyée, donc un appel non attendu après res.json() n'est
    // pas garanti d'aboutir (silencieusement manqué, de façon intermittente).
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

// Route pour changer la guilde d'un utilisateur (admin seulement)
// bbs_id optionnel : cible ce compte précis ; par défaut, le compte principal.
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

    // Vérifier les contraintes si un rôle spécifique est demandé (au niveau des comptes, pas des users)
    if (newRole === 'chef' || newRole === 'sous-chef') {
      await assertRoleAvailable(req.db, guildeId, newRole, targetAccount?.bbs_id);
    }

    // Mettre à jour la guilde et le rôle du compte ciblé
    const bbsAccounts = bbs_id
      ? updateAccount(user.bbs_accounts, bbs_id, { guildeId, role: newRole })
      : upsertPrimaryAccount(user.bbs_accounts, {
          bbsId: targetAccount?.bbs_id, bbsName: targetAccount?.bbs_name, guildeId, role: newRole
        });

    await req.db.collection('users').updateOne(
      { _id: user._id },
      { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
    );

    // Notification Discord — uniquement pertinente pour le compte principal (c'est ce que
    // reflètent les champs racine guilde_id/role affichés ailleurs) — attendue avant la réponse.
    if (!bbs_id || targetAccount?.is_primary) {
      await notifyGuildChange(req.db, user, guildeId).catch(e =>
        logger.error('[users/guild] Erreur notification Discord:', e.message)
      );
    }

    res.json({ success: true, message: `${getUserDisplayName(user, 'Utilisateur')} déplacé vers la nouvelle guilde` });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors du changement de guilde:');
  }
});

export default router;
