import express from 'express';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { requireDb } from '../middleware/auth.js';

const router = express.Router();

// Middleware to ensure database connection
router.use(requireDb);

// GET /guides - Retrieve all guide types available
router.get('/', async (req, res) => {
  try {
    const guideTypes = await req.db.collection('guide_orbe').aggregate([
      { $group: { _id: null, types: { $addToSet: '$type' } } }
    ]).toArray();
    
    res.json({
      availableGuides: ['orbes', 'stuff', 'xp'], // Types de guides disponibles
      data: guideTypes
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch guides' });
  }
});

// GET /guides/orbes - Guide spécifique au farm d'orbes
router.get('/orbes', async (req, res) => {
  try {
    const orbesGuide = await req.db.collection('guide_orbe')
      .find()
      .sort({ amount: -1 }) // Tri par montant décroissant
      .toArray();
    
    // Calcul du total d'orbes disponibles
    const totalOrbes = orbesGuide.reduce((sum, source) => sum + (source.amount || 0), 0);
    
    res.json({
      totalOrbes,
      data: orbesGuide
    });
  } catch (error) {
    console.error('Error fetching orbes guide:', error);
    res.status(500).json({ error: 'Failed to fetch orbes guide' });
  }
});

// POST /guides/orbes - Ajouter une nouvelle entrée au guide des orbes
router.post('/orbes', async (req, res) => {
  try {
    const newEntry = req.body;
    
    const result = await req.db.collection('guide_orbe').insertOne(newEntry);
    
    res.status(201).json({ 
      message: `Ajout de '${newEntry.title}' réussi`,
      insertedId: result.insertedId
    });
  } catch (error) {
    console.error('Error adding orbes guide entry:', error);
    res.status(500).json({ error: 'Failed to add entry' });
  }
});

// DELETE /guides/orbes/:id - Supprimer une entrée du guide des orbes
router.delete('/orbes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await req.db.collection('guide_orbe').deleteOne({ 
      _id: new ObjectId(id) 
    });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Entry not found' });
    }
    
    res.json({ message: `Suppression de l'entrée avec l'ID '${id}' réussie` });
  } catch (error) {
    console.error('Error deleting orbes guide entry:', error);
    res.status(500).json({ error: 'Failed to delete entry' });
  }
});

// PATCH /guides/orbes/:id - Mettre à jour une entrée spécifique du guide des orbes
router.patch('/orbes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const result = await req.db.collection('guide_orbe').updateOne(
      { _id: new ObjectId(id) },
      { $set: updates }
    );
    
    if (result.matchedCount === 0) {
      return res.status(404).json({ error: `Entrée avec l'ID ${id} non trouvée` });
    }
    
    res.json({ 
      message: `Mise à jour de '${updates.title || id}' réussie`,
      modifiedCount: result.modifiedCount
    });
  } catch (error) {
    console.error('Error updating orbes guide entry:', error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});


// GET /guides/stuff - Guide pour le farm de stuff (à implémenter)
router.get('/stuff', async (req, res) => {
  try {
    // Collection dédiée pour le guide stuff
    const stuffGuide = await req.db.collection('guide_stuff')
      .find()
      .toArray();
    
    res.json({
      title: "Guide du Farm de Stuff",
      description: "Guide pour obtenir le meilleur équipement",
      items: stuffGuide
    });
  } catch (error) {
    console.error('Error fetching stuff guide:', error);
    res.status(500).json({ error: 'Failed to fetch stuff guide' });
  }
});

// GET /guides/:type - Route générique pour les nouveaux types de guides
router.get('/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const collectionName = `guide_${type}`;
    
    // Vérifier si la collection existe
    const collections = await req.db.listCollections({ name: collectionName }).toArray();
    
    if (collections.length === 0) {
      return res.status(404).json({ 
        error: 'Guide type not found',
        availableTypes: ['orbes', 'stuff', 'xp']
      });
    }
    
    const guideData = await req.db.collection(collectionName)
      .find()
      .toArray();
    
    res.json({
      type,
      data: guideData
    });
  } catch (error) {
    console.error(`Error fetching ${req.params.type} guide:`, error);
    res.status(500).json({ error: `Failed to fetch ${req.params.type} guide` });
  }
});

export default router;