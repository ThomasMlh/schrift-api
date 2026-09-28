import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb, requireAdmin } from '../middleware/auth.js';

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
      availableGuides: ['orbes', 'stuff', 'xp', 'ability-slots'], // Types de guides disponibles
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


// Calcule l'ordre d'insertion pour une catégorie : à la suite de la dernière
// ligne de cette catégorie si elle existe déjà, sinon à la toute fin du
// tableau. La numérotation démarre à 1.
const computeAbilitySlotInsertOrder = async (db, category) => {
  const [lastInCategory] = await db.collection('guide_ability_slots')
    .find({ category })
    .sort({ order: -1 })
    .limit(1)
    .toArray();

  if (lastInCategory) {
    return lastInCategory.order + 1;
  }

  const [lastOverall] = await db.collection('guide_ability_slots')
    .find()
    .sort({ order: -1 })
    .limit(1)
    .toArray();

  return (lastOverall?.order ?? 0) + 1;
};

// GET /guides/ability-slots - Tableau des emplacements de capacités
router.get('/ability-slots', async (req, res) => {
  try {
    const abilitySlotsGuide = await req.db.collection('guide_ability_slots')
      .find()
      .sort({ order: 1 })
      .toArray();

    res.json({ data: abilitySlotsGuide });
  } catch (error) {
    console.error('Error fetching ability slots guide:', error);
    res.status(500).json({ error: 'Failed to fetch ability slots guide' });
  }
});

// POST /guides/ability-slots - Ajouter une ligne au tableau des emplacements de capacités
// L'ordre est toujours calculé automatiquement (à la suite de la catégorie
// concernée) pour éviter les doublons/collisions entre catégories.
router.post('/ability-slots', requireAdmin, async (req, res) => {
  try {
    const { category, name, star1, star2, star3 } = req.body;

    if (!name || !category) {
      return res.status(400).json({ error: 'Les champs "category" et "name" sont requis' });
    }

    const collection = req.db.collection('guide_ability_slots');
    const insertOrder = await computeAbilitySlotInsertOrder(req.db, category);

    // Décale les lignes suivantes pour garder les catégories contiguës
    await collection.updateMany({ order: { $gte: insertOrder } }, { $inc: { order: 1 } });

    const result = await collection.insertOne({
      category,
      name,
      star1: star1 || '',
      star2: star2 || '',
      star3: star3 || '',
      order: insertOrder,
    });

    res.status(201).json({
      message: `Ajout de '${name}' réussi`,
      insertedId: result.insertedId
    });
  } catch (error) {
    console.error('Error adding ability slots guide entry:', error);
    res.status(500).json({ error: 'Failed to add entry' });
  }
});

// DELETE /guides/ability-slots/:id - Supprimer une ligne du tableau des emplacements de capacités
router.delete('/ability-slots/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await req.db.collection('guide_ability_slots').deleteOne({
      _id: new ObjectId(id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Entry not found' });
    }

    res.json({ message: `Suppression de l'entrée avec l'ID '${id}' réussie` });
  } catch (error) {
    console.error('Error deleting ability slots guide entry:', error);
    res.status(500).json({ error: 'Failed to delete entry' });
  }
});

// PATCH /guides/ability-slots/:id - Mettre à jour une ligne du tableau des emplacements de capacités
// L'ordre n'est jamais accepté depuis le client : si la catégorie change, il
// est recalculé automatiquement pour recoller la ligne à la suite de sa
// nouvelle catégorie.
router.patch('/ability-slots/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = { ...req.body };
    delete updates.order;

    const collection = req.db.collection('guide_ability_slots');
    const current = await collection.findOne({ _id: new ObjectId(id) });

    if (!current) {
      return res.status(404).json({ error: `Entrée avec l'ID ${id} non trouvée` });
    }

    if (updates.category && updates.category !== current.category) {
      const insertOrder = await computeAbilitySlotInsertOrder(req.db, updates.category);
      await collection.updateMany(
        { _id: { $ne: current._id }, order: { $gte: insertOrder } },
        { $inc: { order: 1 } }
      );
      updates.order = insertOrder;
    }

    const result = await collection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updates }
    );

    res.json({
      message: `Mise à jour de '${updates.name || current.name}' réussie`,
      modifiedCount: result.modifiedCount
    });
  } catch (error) {
    console.error('Error updating ability slots guide entry:', error);
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
        availableTypes: ['orbes', 'stuff', 'xp', 'ability-slots']
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