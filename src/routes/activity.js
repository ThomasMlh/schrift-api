import express from 'express';
import { requireDb, requireScoresAccess } from '../middleware/auth.js';
import { parsePaginationParams, buildPaginationMeta } from '../utils/pagination.js';
import { isValidNotificationType } from '../utils/notificationTypes.js';
import { sendServerErrorWithFlag } from '../utils/httpErrors.js';

const router = express.Router();

router.use(requireDb);

// Paginated, filterable activity log. Admins see every guild; leaders/officers are scoped to the
// guilds they manage (req.user.allowedGuildIds, set by requireScoresAccess).
router.get('/', requireScoresAccess, async (req, res) => {
  try {
    const { page, limit, skip } = parsePaginationParams(req.query);
    const { type, guilde_id, from, to } = req.query;

    const filter = {};

    if (!req.user.hasFullAccess) {
      const allowedGuildIds = req.user.allowedGuildIds || [];
      filter.guilde_id = { $in: allowedGuildIds };
    } else if (guilde_id) {
      filter.guilde_id = guilde_id;
    }

    if (type) {
      if (!isValidNotificationType(type)) {
        return res.status(400).json({ success: false, message: `Type de notification inconnu: ${type}` });
      }
      filter.type = type;
    }

    if (from || to) {
      filter.created_at = {};
      if (from) filter.created_at.$gte = new Date(from);
      if (to) filter.created_at.$lte = new Date(to);
    }

    const collection = req.db.collection('activity_log');
    const [activity, totalCount] = await Promise.all([
      collection.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit).toArray(),
      collection.countDocuments(filter),
    ]);

    res.json({
      success: true,
      activity,
      pagination: buildPaginationMeta(page, limit, totalCount, activity.length),
    });
  } catch (err) {
    sendServerErrorWithFlag(res, err);
  }
});

export default router;
