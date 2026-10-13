import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb, requireAdmin } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(requireDb);

// GET /guides - available guide types
router.get('/', async (req, res) => {
  try {
    const guideTypes = await req.db.collection('guide_orbe').aggregate([
      { $group: { _id: null, types: { $addToSet: '$type' } } }
    ]).toArray();
    
    res.json({
      availableGuides: ['orbes', 'stuff', 'xp', 'ability-slots'],
      data: guideTypes
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch guides' });
  }
});

// GET /guides/orbes - orb farming guide
router.get('/orbes', async (req, res) => {
  try {
    const orbesGuide = await req.db.collection('guide_orbe')
      .find()
      .sort({ amount: -1 })
      .toArray();
    
    const totalOrbes = orbesGuide.reduce((sum, source) => sum + (source.amount || 0), 0);
    
    res.json({
      totalOrbes,
      data: orbesGuide
    });
  } catch (error) {
    logger.error('Error fetching orbes guide:', error);
    res.status(500).json({ error: 'Failed to fetch orbes guide' });
  }
});

// POST /guides/orbes - add an orb guide entry
router.post('/orbes', requireAdmin, async (req, res) => {
  try {
    const newEntry = req.body;
    
    const result = await req.db.collection('guide_orbe').insertOne(newEntry);
    
    res.status(201).json({ 
      message: `Ajout de '${newEntry.title}' réussi`,
      insertedId: result.insertedId
    });
  } catch (error) {
    logger.error('Error adding orbes guide entry:', error);
    res.status(500).json({ error: 'Failed to add entry' });
  }
});

// DELETE /guides/orbes/:id - delete an orb guide entry
router.delete('/orbes/:id', requireAdmin, async (req, res) => {
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
    logger.error('Error deleting orbes guide entry:', error);
    res.status(500).json({ error: 'Failed to delete entry' });
  }
});

// PATCH /guides/orbes/:id - update an orb guide entry
router.patch('/orbes/:id', requireAdmin, async (req, res) => {
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
    logger.error('Error updating orbes guide entry:', error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});


// Insertion order for a category: right after the category's last row when it exists, otherwise
// at the end of the table. Numbering starts at 1.
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

// GET /guides/ability-slots - ability slots table
router.get('/ability-slots', async (req, res) => {
  try {
    const abilitySlotsGuide = await req.db.collection('guide_ability_slots')
      .find()
      .sort({ order: 1 })
      .toArray();

    res.json({ data: abilitySlotsGuide });
  } catch (error) {
    logger.error('Error fetching ability slots guide:', error);
    res.status(500).json({ error: 'Failed to fetch ability slots guide' });
  }
});

// POST /guides/ability-slots - add an ability slots row.
// The order is always computed (right after its category) to avoid collisions between categories.
router.post('/ability-slots', requireAdmin, async (req, res) => {
  try {
    const { category, name, star1, star2, star3 } = req.body;

    if (!name || !category) {
      return res.status(400).json({ error: 'Les champs "category" et "name" sont requis' });
    }

    const collection = req.db.collection('guide_ability_slots');
    const insertOrder = await computeAbilitySlotInsertOrder(req.db, category);

    // Shift the following rows so categories stay contiguous
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
    logger.error('Error adding ability slots guide entry:', error);
    res.status(500).json({ error: 'Failed to add entry' });
  }
});

// DELETE /guides/ability-slots/:id - delete an ability slots row
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
    logger.error('Error deleting ability slots guide entry:', error);
    res.status(500).json({ error: 'Failed to delete entry' });
  }
});

// PATCH /guides/ability-slots/:id - update an ability slots row.
// The order is never taken from the client: when the category changes, it is recomputed to place
// the row after its new category.
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
    logger.error('Error updating ability slots guide entry:', error);
    res.status(500).json({ error: 'Failed to update entry' });
  }
});


// GET /guides/stuff - gear farming guide
router.get('/stuff', async (req, res) => {
  try {
    const stuffGuide = await req.db.collection('guide_stuff')
      .find()
      .toArray();
    
    res.json({
      title: "Guide du Farm de Stuff",
      description: "Guide pour obtenir le meilleur équipement",
      items: stuffGuide
    });
  } catch (error) {
    logger.error('Error fetching stuff guide:', error);
    res.status(500).json({ error: 'Failed to fetch stuff guide' });
  }
});

// GET /guides/:type - generic route for other guide types
router.get('/:type', async (req, res) => {
  try {
    const { type } = req.params;
    const collectionName = `guide_${type}`;
    
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
    logger.error(`Error fetching ${req.params.type} guide:`, error);
    res.status(500).json({ error: `Failed to fetch ${req.params.type} guide` });
  }
});

export default router;