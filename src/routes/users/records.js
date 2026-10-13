import express from 'express';
import { ObjectId } from 'mongodb';
import { validateObjectIdParam } from '../../middleware/auth.js';
import { getAccountRecords } from '../../services/killerRecords.js';
import { getAchievementsForAccounts } from '../../services/achievements.js';
import { sendStatusCodeError } from '../../utils/httpErrors.js';

const router = express.Router();

// GET a player's personal records: best score of each of their bbs accounts on each killer.
// Public, like the player page stats.
router.get('/:userId/records', validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const user = await req.db.collection('users').findOne(
      { _id: new ObjectId(req.params.userId) },
      { projection: { bbs_accounts: 1 } }
    );
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    const accounts = (user.bbs_accounts || []).filter((a) => a.bbs_id);
    const recordsByAccount = await getAccountRecords(req.db, accounts.map((a) => a.bbs_id));

    res.json({
      success: true,
      data: accounts.map((a) => ({
        bbs_id: a.bbs_id,
        bbs_name: a.bbs_name || null,
        is_primary: !!a.is_primary,
        records: recordsByAccount.get(a.bbs_id) || [],
      })),
    });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de la récupération des records', 'Erreur lors de la récupération des records du joueur:');
  }
});

// GET a player's achievements: state of each achievement for each of their bbs accounts, with the
// rarity of each tier. Public, like the records.
router.get('/:userId/achievements', validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const user = await req.db.collection('users').findOne(
      { _id: new ObjectId(req.params.userId) },
      { projection: { bbs_accounts: 1 } }
    );
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    const accounts = (user.bbs_accounts || []).filter((a) => a.bbs_id);
    const { accounts: achievementsByAccount, totalAccounts } = await getAchievementsForAccounts(req.db, accounts.map((a) => a.bbs_id));

    res.json({
      success: true,
      total_accounts: totalAccounts,
      data: accounts.map((a) => ({
        bbs_id: a.bbs_id,
        bbs_name: a.bbs_name || null,
        is_primary: !!a.is_primary,
        achievements: achievementsByAccount.get(a.bbs_id) || [],
      })),
    });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de la récupération des succès', 'Erreur lors de la récupération des succès du joueur:');
  }
});

export default router;
