import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb, requireScoresAccess } from '../middleware/auth.js';
import { listDiscordChannels, sendDiscordMessage } from '../utils/botClient.js';
import { sendStatusCodeError } from '../utils/httpErrors.js';

const router = express.Router();

router.use(requireDb);

// Résout les salons Discord enregistrés (chefs + général) pour les guildes qu'un
// chef/sous-chef gère, pour limiter sa vue/ses envois à ces salons-là uniquement.
// Un admin (hasFullAccess) n'a pas besoin de cette résolution : il voit/écrit partout.
const getAllowedChannelIds = async (db, guildIds) => {
  if (!guildIds || guildIds.length === 0) return new Set();
  const guildes = await db.collection('guildes').find(
    { _id: { $in: guildIds.map((id) => new ObjectId(id)) } },
    { projection: { discord_channel_id: 1, discord_general_channel_id: 1 } }
  ).toArray();

  const ids = new Set();
  for (const guilde of guildes) {
    if (guilde.discord_channel_id) ids.add(guilde.discord_channel_id);
    if (guilde.discord_general_channel_id) ids.add(guilde.discord_general_channel_id);
  }
  return ids;
};

// GET liste des salons Discord accessibles à l'utilisateur, avec leurs membres.
// Admin : tous les salons que le bot voit. Chef/sous-chef : uniquement les salons
// (chefs + général) de la ou des guildes qu'il gère.
router.get('/channels', requireScoresAccess, async (req, res) => {
  try {
    const channels = await listDiscordChannels();

    if (req.user.hasFullAccess) {
      return res.json({ success: true, channels });
    }

    const allowedChannelIds = await getAllowedChannelIds(req.db, req.user.allowedGuildIds);
    const filtered = channels.filter((c) => allowedChannelIds.has(c.id));
    res.json({ success: true, channels: filtered });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de la récupération des salons Discord', 'Erreur lors de la récupération des salons Discord:');
  }
});

// POST envoyer un message à un salon Discord via le bot.
// Admin : n'importe quel salon. Chef/sous-chef : uniquement les salons de sa/ses guildes.
router.post('/messages', requireScoresAccess, async (req, res) => {
  try {
    const { channel_id, content, mention_user_ids } = req.body;

    if (!channel_id) {
      return res.status(400).json({ success: false, message: 'channel_id requis' });
    }
    if (!content || !String(content).trim()) {
      return res.status(400).json({ success: false, message: 'content requis' });
    }
    if (mention_user_ids !== undefined && !Array.isArray(mention_user_ids)) {
      return res.status(400).json({ success: false, message: 'mention_user_ids doit être un tableau' });
    }

    if (!req.user.hasFullAccess) {
      const allowedChannelIds = await getAllowedChannelIds(req.db, req.user.allowedGuildIds);
      if (!allowedChannelIds.has(String(channel_id))) {
        return res.status(403).json({ success: false, message: 'Accès refusé à ce salon' });
      }
    }

    const result = await sendDiscordMessage({ channel_id, content, mention_user_ids });
    res.json({ success: true, ...result });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de l\'envoi du message Discord', 'Erreur lors de l\'envoi du message Discord:');
  }
});

export default router;
