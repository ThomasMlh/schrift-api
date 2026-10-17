import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb, requireAuth } from '../middleware/auth.js';
import { sendHiddenServiceError } from '../utils/httpErrors.js';

// Character albums: one document per bbs account (keyed by bbs_id, like the score history, so the
// album follows the account when it is transferred between users).
// characters = { <character _id>: spec }: a listed character is owned (spec 1 by default, up to 5
// with duplicates), a missing one is not.
const router = express.Router();

export const MAX_SPE = 5;

router.use(requireDb);

// Does the bbs account exist, and which user owns it?
const findAccountOwner = (db, bbsId) =>
  db.collection('users').findOne(
    { $or: [{ 'bbs_accounts.bbs_id': bbsId }, { bbs_id: bbsId }] },
    { projection: { _id: 1 } }
  );

// GET an account's album (public)
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

// PUT a character's spec in an account's album (account owner or admin).
// spe = 0 removes the character from the album.
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
