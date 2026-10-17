import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, requireDb } from '../middleware/auth.js';
import { sendServerError, sendStatusCodeError } from '../utils/httpErrors.js';
import { getRotationHistory } from '../services/killerRecords.js';

const router = express.Router();

router.use(requireDb);

// GET every rotation
router.get('/', async (req, res) => {
  try {
    const rotations = await req.db.collection('rotations').find().toArray();
    res.json(rotations);
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET a rotation by id
router.get('/:id', async (req, res) => {
  try {
    const rotation = await req.db.collection('rotations').findOne({ _id: new ObjectId(req.params.id) });
    if (!rotation) {
      return res.status(404).json({ success: false, message: 'Rotation non trouvée' });
    }
    res.json(rotation);
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET a killer's history (= a template rotation) across all cycles: records, per-cycle averages,
// score to beat. Public, like the rotation scores shown on the same page.
// Query: guild_id (optional) for the guild scope, cycle_id (optional) for the score to beat.
router.get('/:id/history', async (req, res) => {
  try {
    const { guild_id, cycle_id } = req.query;
    const history = await getRotationHistory(req.db, req.params.id, {
      guildId: guild_id || undefined,
      currentCycleId: cycle_id || undefined,
    });
    res.json({ success: true, data: history });
  } catch (err) {
    sendStatusCodeError(res, err, "Erreur serveur lors de la récupération de l'historique du killer", "Erreur lors de la récupération de l'historique du killer:");
  }
});

// POST create a rotation
router.post('/', requireAdmin, async (req, res) => {
  try {
    const result = await req.db.collection('rotations').insertOne(req.body);
    res.json({ 
      success: true,
      insertedId: result.insertedId,
      message: 'Rotation ajoutée avec succès'
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST create several rotations
router.post('/bulk', requireAdmin, async (req, res) => {
  try {
    const rotations = req.body;
    if (!Array.isArray(rotations) || rotations.length === 0) {
      return res.status(400).json({ success: false, message: 'Aucune rotation à ajouter' });
    }

    const result = await req.db.collection('rotations').insertMany(rotations);
    res.json({ 
      success: true,
      insertedCount: result.insertedCount,
      insertedIds: result.insertedIds,
      message: `${result.insertedCount} rotations ajoutées avec succès`
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

// PUT update a rotation
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const rotationId = req.params.id;
    
    const result = await req.db.collection('rotations').updateOne(
      { _id: new ObjectId(rotationId) },
      { $set: req.body }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Rotation non trouvée' });
    }

    res.json({ success: true, message: 'Rotation mise à jour avec succès' });
  } catch (err) {
    sendServerError(res, err);
  }
});

// DELETE a rotation
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const result = await req.db.collection('rotations').deleteOne({ _id: new ObjectId(req.params.id) });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Rotation non trouvée' });
    }

    res.json({ success: true, message: 'Rotation supprimée avec succès' });
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;