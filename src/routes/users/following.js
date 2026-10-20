import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAuth } from '../../middleware/auth.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

export const MAX_FOLLOWED = 50;

const currentUserFilter = (user) =>
  user._id && ObjectId.isValid(user._id) ? { _id: new ObjectId(user._id) } : { discord_id: user.discord_id };

// Followed accounts with what is needed to display them (accounts that no longer exist are skipped)
const describeFollowed = async (db, bbsIds) => {
  if (bbsIds.length === 0) return [];
  const users = await db.collection('users').find(
    { 'bbs_accounts.bbs_id': { $in: bbsIds } },
    { projection: { discord_id: 1, global_name: 1, username: 1, avatar: 1, bbs_accounts: 1 } }
  ).toArray();
  const guildIds = [...new Set(users.flatMap((u) => (u.bbs_accounts || []).map((a) => a.guilde_id)).filter((id) => id && ObjectId.isValid(id)))];
  const guilds = await db.collection('guildes')
    .find({ _id: { $in: guildIds.map((id) => new ObjectId(id)) } }, { projection: { name: 1 } })
    .toArray();
  const guildName = new Map(guilds.map((g) => [g._id.toString(), g.name]));

  const byBbsId = new Map();
  for (const user of users) {
    for (const account of user.bbs_accounts || []) {
      if (!bbsIds.includes(account.bbs_id)) continue;
      byBbsId.set(account.bbs_id, {
        bbs_id: account.bbs_id,
        bbs_name: account.bbs_name || null,
        user_id: user._id.toString(),
        discord_id: user.discord_id,
        global_name: user.global_name,
        avatar: user.avatar,
        guild_name: guildName.get(account.guilde_id) || null,
      });
    }
  }
  return bbsIds.map((id) => byBbsId.get(id)).filter(Boolean);
};

// GET the accounts followed by the logged-in user
router.get('/me/following', requireAuth, async (req, res) => {
  try {
    const me = await req.db.collection('users').findOne(currentUserFilter(req.user), { projection: { following: 1 } });
    res.json({ success: true, following: await describeFollowed(req.db, me?.following || []) });
  } catch (err) {
    logger.error('Erreur lors de la récupération des joueurs suivis:', err);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// PUT follow a bbs account
router.put('/me/following/:bbsId', requireAuth, async (req, res) => {
  try {
    const { bbsId } = req.params;
    const filter = currentUserFilter(req.user);
    const me = await req.db.collection('users').findOne(filter, { projection: { following: 1, bbs_accounts: 1 } });
    if (!me) return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    if ((me.bbs_accounts || []).some((a) => a.bbs_id === bbsId)) {
      return res.status(400).json({ success: false, message: 'Impossible de suivre son propre compte' });
    }
    const exists = await req.db.collection('users').countDocuments({ 'bbs_accounts.bbs_id': bbsId }, { limit: 1 });
    if (!exists) return res.status(404).json({ success: false, message: 'Compte bbs introuvable' });

    const following = me.following || [];
    if (!following.includes(bbsId) && following.length >= MAX_FOLLOWED) {
      return res.status(400).json({ success: false, message: `Vous suivez déjà ${MAX_FOLLOWED} joueurs (maximum)` });
    }
    await req.db.collection('users').updateOne(filter, { $addToSet: { following: bbsId } });
    res.json({ success: true, following: [...new Set([...following, bbsId])] });
  } catch (err) {
    logger.error('Erreur lors du suivi d\'un joueur:', err);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// DELETE stop following a bbs account
router.delete('/me/following/:bbsId', requireAuth, async (req, res) => {
  try {
    const filter = currentUserFilter(req.user);
    await req.db.collection('users').updateOne(filter, { $pull: { following: req.params.bbsId } });
    const me = await req.db.collection('users').findOne(filter, { projection: { following: 1 } });
    res.json({ success: true, following: me?.following || [] });
  } catch (err) {
    logger.error('Erreur lors de l\'arrêt du suivi d\'un joueur:', err);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

export default router;
