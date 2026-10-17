import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, validateObjectIdParam } from '../../middleware/auth.js';
import { notifyDiscord } from '../../utils/notifyDiscord.js';
import { getUserStats } from '../../services/userStats.js';
import { getUserDisplayName } from '../../utils/nameMatching.js';
import { USER_DISPLAY } from '../../utils/projections.js';
import { logger } from '../../utils/logger.js';
import { sendHiddenServiceError } from '../../utils/httpErrors.js';

const router = express.Router();

// GET a player's personal stats by user_id
router.get('/:user_id/stats', async (req, res) => {
  try {
    const data = await getUserStats(req.db, req.params.user_id, req.query);
    return res.json({ success: true, data });

  } catch (error) {
    return sendHiddenServiceError(res, error, 'Erreur lors de la récupération des statistiques du joueur:', 'Erreur serveur lors de la récupération des statistiques');
  }
});

// POST ban a user (admin only)
router.post('/:userId/ban', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;
    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });

    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    if (user.is_admin) {
      return res.status(403).json({ success: false, message: 'Impossible de bannir un administrateur' });
    }

    if (user.is_banned) {
      return res.status(400).json({ success: false, message: 'Cet utilisateur est déjà banni' });
    }

    await req.db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      {
        $set: {
          is_banned: true,
          ban_reason: reason || null,
          banned_at: new Date(),
          banned_by: req.user.discord_id
        }
      }
    );

    // Discord notification (non-blocking)
    try {
      const banner = await req.db.collection('users').findOne(
        { _id: new ObjectId(req.user._id) },
        { projection: USER_DISPLAY }
      );
      const bannerName = getUserDisplayName(banner);
      const bannedName = getUserDisplayName(user);
      await notifyDiscord('ban', {
        action: 'ban',
        banned_by: bannerName,
        banned_user: bannedName,
        reason: reason || null,
        banned_at: new Date().toISOString()
      }, process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
    } catch (notifErr) {
      logger.error('[users/ban] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.json({
      success: true,
      message: `${getUserDisplayName(user)} a été banni avec succès`
    });
  } catch (error) {
    logger.error('Erreur lors du bannissement:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// POST unban a user (admin only)
router.post('/:userId/unban', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });

    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    if (!user.is_banned) {
      return res.status(400).json({ success: false, message: 'Cet utilisateur n\'est pas banni' });
    }

    await req.db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      {
        $set: {
          is_banned: false,
          ban_reason: null,
          banned_at: null,
          banned_by: null
        }
      }
    );

    // Discord notification (non-blocking)
    try {
      const unbanner = await req.db.collection('users').findOne(
        { _id: new ObjectId(req.user._id) },
        { projection: USER_DISPLAY }
      );
      const unbannerName = getUserDisplayName(unbanner);
      const unbannedName = getUserDisplayName(user);
      await notifyDiscord('ban', {
        action: 'unban',
        banned_by: unbannerName,
        banned_user: unbannedName,
        reason: null
      }, process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
    } catch (notifErr) {
      logger.error('[users/unban] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.json({
      success: true,
      message: `${getUserDisplayName(user)} a été débanni avec succès`
    });
  } catch (error) {
    logger.error('Erreur lors du débannissement:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

export default router;
