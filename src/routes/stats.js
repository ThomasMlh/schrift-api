import express from 'express';
import { requireDb } from '../middleware/auth.js';

const router = express.Router();
router.use(requireDb);

// Statistiques globales de la communauté
router.get('/community', async (req, res) => {
  try {
    const cycleId = req.query.cycle_id;

    const activeGuilds = await req.db.collection('guildes')
      .find({ disabled: { $ne: true } }, { projection: { _id: 1 } })
      .toArray();

    const totalGuilds = activeGuilds.length;
    const activeGuildIds = activeGuilds.map(g => g._id.toString());

    const communityUsers = await req.db.collection('users').find(
      {
        $or: [
          { guilde_id: { $in: activeGuildIds } },
          { 'bbs_accounts.guilde_id': { $in: activeGuildIds } },
        ],
      },
      { projection: { _id: 1, guilde_id: 1, bbs_accounts: 1 } }
    ).toArray();

    let totalMembers = 0;
    const memberIds = [];
    for (const user of communityUsers) {
      const accounts = Array.isArray(user.bbs_accounts) && user.bbs_accounts.length > 0
        ? user.bbs_accounts
        : [{ guilde_id: user.guilde_id }];
      const activeAccountsCount = accounts.filter(a => activeGuildIds.includes(a.guilde_id)).length;
      if (activeAccountsCount > 0) {
        totalMembers += activeAccountsCount;
        memberIds.push(user._id.toString());
      }
    }

    const scoresQuery = { user_id: { $in: memberIds } };
    if (cycleId) scoresQuery.cycle_id = cycleId;

    const scores = await req.db.collection('scores').find(scoresQuery, { projection: { score: 1 } }).toArray();
    const totalScores = scores.length;
    const clearCount = scores.filter(s => (s.score || 0) >= 600_000_000).length;
    const globalClearRate = totalScores > 0 ? Math.round((clearCount / totalScores) * 10000) / 100 : 0;
    const totalPoints = scores.reduce((s, sc) => s + (sc.score || 0), 0);
    const avgScore = totalScores > 0 ? Math.round(totalPoints / totalScores) : 0;

    res.json({ success: true, data: { totalMembers, totalGuilds, totalScores, globalClearRate, avgScore } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
