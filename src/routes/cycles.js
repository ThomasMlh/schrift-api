import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb } from '../middleware/auth.js';

const router = express.Router();

// Middleware pour toutes les routes cycles
router.use(requireDb);

// GET tous les cycles avec pagination
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50; // Harmonisé avec characters
    const skip = (page - 1) * limit;

    // Limiter le nombre max par page pour éviter les abus
    const maxLimit = 200;
    const actualLimit = Math.min(limit, maxLimit);

    const cycles = await req.db.collection('cycles')
      .find()
      .sort({ _id: -1 })
      .skip(skip)
      .limit(actualLimit)
      .toArray();

    const totalCount = await req.db.collection('cycles').countDocuments();
    const totalPages = Math.ceil(totalCount / actualLimit);

    res.json({
      success: true,
      data: cycles,
      pagination: {
        currentPage: page,
        totalPages,
        totalCount,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
        itemsPerPage: actualLimit,
        itemsOnPage: cycles.length
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET un cycle spécifique par ID
router.get('/:cycleId', async (req, res) => {
  try {
    const cycle = await req.db.collection('cycles').findOne({ 
      _id: new ObjectId(req.params.cycleId) 
    });
    
    if (!cycle) {
      return res.status(404).json({ success: false, message: 'Cycle non trouvé' });
    }
    
    res.json({ success: true, cycle });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST créer un nouveau cycle
router.post('/', async (req, res) => {
  try {
    const { name, rotations } = req.body;

    // Validation : exactement 20 rotations
    if (!rotations || rotations.length !== 20) {
      return res.status(400).json({
        success: false,
        message: 'Un cycle doit contenir exactement 20 rotations'
      });
    }

    // Validation : toutes les rotations doivent être uniques
    const rotationStrings = rotations.map(rotation => 
      JSON.stringify({
        start_date: rotation.start_date,
        end_date: rotation.end_date,
        period: rotation.period,
        killer: rotation.killer,
        attack: rotation.attack,
        alteration: rotation.alteration
      })
    );

    const uniqueRotations = new Set(rotationStrings);
    if (uniqueRotations.size !== rotations.length) {
      return res.status(400).json({
        success: false,
        message: 'Toutes les rotations doivent être uniques. Des doublons ont été détectés.'
      });
    }

    // Ajouter des IDs aux rotations
    const rotationsWithIds = rotations.map(rotation => ({
      ...rotation,
      _id: new ObjectId()
    }));

    const cycle = {
      name,
      rotations: rotationsWithIds,
      created_at: new Date(),
      updated_at: new Date()
    };

    const result = await req.db.collection('cycles').insertOne(cycle);
    
    res.status(201).json({
      success: true,
      id: result.insertedId,
      message: 'Cycle créé avec succès'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT modifier un cycle
router.put('/:cycleId', async (req, res) => {
  try {
    const { name, rotations } = req.body;

    // Validation : exactement 20 rotations
    if (rotations && rotations.length !== 20) {
      return res.status(400).json({
        success: false,
        message: 'Un cycle doit contenir exactement 20 rotations'
      });
    }

    // Validation : toutes les rotations doivent être uniques (si rotations fournies)
    if (rotations) {
      const rotationStrings = rotations.map(rotation => 
        JSON.stringify({
          start_date: rotation.start_date,
          end_date: rotation.end_date,
          period: rotation.period,
          killer: rotation.killer,
          attack: rotation.attack,
          alteration: rotation.alteration
        })
      );

      const uniqueRotations = new Set(rotationStrings);
      if (uniqueRotations.size !== rotations.length) {
        return res.status(400).json({
          success: false,
          message: 'Toutes les rotations doivent être uniques. Des doublons ont été détectés.'
        });
      }
    }

    const updateData = {
      updated_at: new Date()
    };

    if (name) updateData.name = name;
    
    if (rotations) {
      // Préserver les IDs existants ou en créer de nouveaux
      updateData.rotations = rotations.map(rotation => ({
        ...rotation,
        _id: rotation._id ? new ObjectId(rotation._id) : new ObjectId()
      }));
    }

    const result = await req.db.collection('cycles').updateOne(
      { _id: new ObjectId(req.params.cycleId) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Cycle non trouvé' });
    }

    res.json({ success: true, message: 'Cycle mis à jour avec succès' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE supprimer un cycle
router.delete('/:cycleId', async (req, res) => {
  try {
    const result = await req.db.collection('cycles').deleteOne({ 
      _id: new ObjectId(req.params.cycleId) 
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Cycle non trouvé' });
    }

    res.json({ success: true, message: 'Cycle supprimé avec succès' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;