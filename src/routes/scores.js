import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb } from '../middleware/auth.js';

const router = express.Router();

// Middleware pour toutes les routes scores
router.use(requireDb);

// Récupérer tous les scores
router.get('/', async (req, res) => {
  try {
    const scores = await req.db.collection('scores').find().toArray();
    res.json(scores);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Récupérer un score par ID
router.get('/:id', async (req, res) => {
  try {
    const score = await req.db.collection('scores').findOne({ _id: new ObjectId(req.params.id) });
    if (!score) {
      return res.status(404).json({ success: false, message: 'Score non trouvé' });
    }
    res.json(score);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ajouter un score
router.post('/', async (req, res) => {
  try {
    const result = await req.db.collection('scores').insertOne(req.body);
    res.json({ 
      success: true,
      insertedId: result.insertedId,
      message: 'Score ajouté avec succès'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Modifier un score
router.put('/:id', async (req, res) => {
  try {
    const scoreId = req.params.id;
    
    const result = await req.db.collection('scores').updateOne(
      { _id: new ObjectId(scoreId) },
      { $set: req.body }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Score non trouvé' });
    }

    res.json({ success: true, message: 'Score mis à jour avec succès' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Supprimer un score
router.delete('/:id', async (req, res) => {
  try {
    const result = await req.db.collection('scores').deleteOne({ _id: new ObjectId(req.params.id) });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Score non trouvé' });
    }

    res.json({ success: true, message: 'Score supprimé avec succès' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;