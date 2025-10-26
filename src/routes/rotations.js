import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, requireDb } from '../middleware/auth.js';

const router = express.Router();

// Middleware pour toutes les routes rotations
router.use(requireDb);

// Récupérer toutes les rotations
router.get('/', async (req, res) => {
  try {
    const rotations = await req.db.collection('rotations').find().toArray();
    res.json(rotations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Récupérer une rotation par ID
router.get('/:id', async (req, res) => {
  try {
    const rotation = await req.db.collection('rotations').findOne({ _id: new ObjectId(req.params.id) });
    if (!rotation) {
      return res.status(404).json({ success: false, message: 'Rotation non trouvée' });
    }
    res.json(rotation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ajouter une rotation
router.post('/', requireAdmin, async (req, res) => {
  try {
    const result = await req.db.collection('rotations').insertOne(req.body);
    res.json({ 
      success: true,
      insertedId: result.insertedId,
      message: 'Rotation ajoutée avec succès'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Modifier une rotation
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
    res.status(500).json({ error: err.message });
  }
});

// Supprimer une rotation
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const result = await req.db.collection('rotations').deleteOne({ _id: new ObjectId(req.params.id) });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Rotation non trouvée' });
    }

    res.json({ success: true, message: 'Rotation supprimée avec succès' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;