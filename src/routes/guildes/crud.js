import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, requireScoresAccess } from '../../middleware/auth.js';
import { getUserDisplayName } from '../../utils/nameMatching.js';
import { notifyDiscord } from '../../utils/notifyDiscord.js';
import { sanitizeDisabledTypes } from '../../utils/notificationTypes.js';
import { USER_DISPLAY } from '../../utils/projections.js';
import { deriveMirrorFields } from '../../utils/bbsAccounts.js';
import { logger } from '../../utils/logger.js';
import { sendServerError } from '../../utils/httpErrors.js';

const router = express.Router();

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

export default router;
