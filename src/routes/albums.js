import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb, requireAuth } from '../middleware/auth.js';
import { sendHiddenServiceError } from '../utils/httpErrors.js';

// Album de personnages : un document par compte bbs (clé = bbs_id, comme l'historique des scores,
// pour que l'album suive le compte en cas de transfert entre users).
// characters = { <character _id>: spé } — un perso présent est possédé (spé 1 d'office,
// jusqu'à 5 avec les doublons), un perso absent ne l'est pas.
const router = express.Router();

export const MAX_SPE = 5;

router.use(requireDb);

// Le compte bbs existe-t-il, et à quel user appartient-il ?
const findAccountOwner = (db, bbsId) =>
  db.collection('users').findOne(
    { $or: [{ 'bbs_accounts.bbs_id': bbsId }, { bbs_id: bbsId }] },
    { projection: { _id: 1 } }
  );

// GET album d'un compte (public)
router.get('/:bbsId', async (req, res) => {
  try {
    const { bbsId } = req.params;
    const album = await req.db.collection('albums').findOne({ bbs_id: bbsId });

    res.json({
      success: true,
      data: {
        bbs_id: bbsId,
        characters: album?.characters || {},
        updated_at: album?.updated_at || null
      }
    });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors de la récupération de l\'album:');
  }
});

// PUT spé d'un perso dans l'album d'un compte (propriétaire du compte ou admin).
// spe = 0 retire le perso de l'album.
router.put('/:bbsId/characters/:characterId', requireAuth, async (req, res) => {
  try {
    const { bbsId, characterId } = req.params;
    const spe = Number(req.body?.spe);

    if (!Number.isInteger(spe) || spe < 0 || spe > MAX_SPE) {
      return res.status(400).json({ success: false, message: `spe doit être un entier entre 0 et ${MAX_SPE}` });
    }
    if (!ObjectId.isValid(characterId)) {
      return res.status(400).json({ success: false, message: 'Format d\'ID personnage invalide' });
    }

    const owner = await findAccountOwner(req.db, bbsId);
    if (!owner) {
      return res.status(404).json({ success: false, message: 'Compte bbs introuvable' });
    }
    if (!req.user.is_admin && String(owner._id) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Tu ne peux modifier que l\'album de tes propres comptes' });
    }

    const character = await req.db.collection('characters').findOne(
      { _id: new ObjectId(characterId) },
      { projection: { _id: 1 } }
    );
    if (!character) {
      return res.status(404).json({ success: false, message: 'Personnage non trouvé' });
    }

    const field = `characters.${characterId}`;
    const update = spe === 0
      ? { $unset: { [field]: '' }, $set: { updated_at: new Date() } }
      : { $set: { [field]: spe, updated_at: new Date() } };

    const album = await req.db.collection('albums').findOneAndUpdate(
      { bbs_id: bbsId },
      update,
      { upsert: true, returnDocument: 'after' }
    );

    res.json({
      success: true,
      data: {
        bbs_id: bbsId,
        characters: album?.characters || {},
        updated_at: album?.updated_at || null
      }
    });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors de la mise à jour de l\'album:');
  }
});

export default router;
