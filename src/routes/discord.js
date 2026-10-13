import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb, requireScoresAccess } from '../middleware/auth.js';
import { listDiscordChannels, listDiscordEmojis, sendDiscordMessage } from '../utils/botClient.js';
import { sendStatusCodeError } from '../utils/httpErrors.js';

const router = express.Router();

router.use(requireDb);

// Resolves the registered Discord channels (leaders + general) of the guilds a leader/officer
// manages, to restrict what they can see and post to. Admins (hasFullAccess) skip this.
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

// GET the Discord channels available to the user, with their members.
// Admin: every channel the bot sees. Leader/officer: only the channels (leaders + general) of
// their guild(s).
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

// GET custom emojis usable in messages. Admin: those of every server the bot is in.
// Leader/officer: only those of servers holding one of their allowed channels (same scope as
// GET /channels).
router.get('/emojis', requireScoresAccess, async (req, res) => {
  try {
    const emojis = await listDiscordEmojis();

    if (req.user.hasFullAccess) {
      return res.json({ success: true, emojis });
    }

    const allowedChannelIds = await getAllowedChannelIds(req.db, req.user.allowedGuildIds);
    if (allowedChannelIds.size === 0) {
      return res.json({ success: true, emojis: [] });
    }

    const channels = await listDiscordChannels();
    const allowedServerIds = new Set(channels.filter((c) => allowedChannelIds.has(c.id)).map((c) => c.guild_id));
    res.json({ success: true, emojis: emojis.filter((e) => allowedServerIds.has(e.guild_id)) });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de la récupération des emojis Discord', 'Erreur lors de la récupération des emojis Discord:');
  }
});

// POST send a message to a Discord channel through the bot.
// Admin: any channel. Leader/officer: only their guild channels.
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
