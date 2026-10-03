import express from 'express';
import { ObjectId } from 'mongodb';
import { requireScoresAccess } from '../../middleware/auth.js';
import { getDeclineAlerts } from '../../services/playerTrends.js';
import { sendServerError } from '../../utils/httpErrors.js';

const router = express.Router();

// GET baisses de régime : membres dont les derniers scores sont nettement sous leur habitude.
// Admin : toutes les guildes actives (ou ?guild_id=). Chef/sous-chef : ses guildes uniquement.
router.get('/decline-alerts', requireScoresAccess, async (req, res) => {
  try {
    const { guild_id } = req.query;
    if (guild_id && !ObjectId.isValid(guild_id)) {
      return res.status(400).json({ success: false, message: 'guild_id invalide' });
    }

    let guildIds;
    if (req.user.hasFullAccess) {
      guildIds = guild_id
        ? [guild_id]
        : (await req.db.collection('guildes').find({ disabled: { $ne: true } }, { projection: { _id: 1 } }).toArray())
          .map((g) => g._id.toString());
    } else {
      const allowed = req.user.allowedGuildIds || [];
      if (guild_id && !allowed.includes(guild_id)) {
        return res.status(403).json({ success: false, message: 'Accès refusé à cette guilde' });
      }
      guildIds = guild_id ? [guild_id] : allowed;
    }

    const alerts = await getDeclineAlerts(req.db, { guildIds });
    res.json({ success: true, alerts });
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;
