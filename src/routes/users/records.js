import express from 'express';
import { ObjectId } from 'mongodb';
import { validateObjectIdParam } from '../../middleware/auth.js';
import { getAccountRecords } from '../../services/killerRecords.js';
import { sendStatusCodeError } from '../../utils/httpErrors.js';

const router = express.Router();

// GET records personnels d'un joueur : meilleur score de chacun de ses comptes bbs sur chaque
// killer. Public, comme les statistiques de la page joueur.
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

export default router;
