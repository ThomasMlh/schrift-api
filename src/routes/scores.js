import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb } from '../middleware/auth.js';

const router = express.Router();

// Middleware pour toutes les routes scores
router.use(requireDb);

// GET tous les scores avec filtres et pagination
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Construction des filtres
    const filters = {};
    
    if (req.query.user_id) {
      filters.user_id = req.query.user_id;
    }
    
    if (req.query.cycle_id) {
      filters.cycle_id = req.query.cycle_id;
    }
    
    if (req.query.rotation_id) {
      filters.rotation_id = req.query.rotation_id;
    }

    const scores = await req.db.collection('scores')
      .find(filters)
      .sort({ _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const total = await req.db.collection('scores').countDocuments(filters);

    res.json({
      success: true,
      scores,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      },
      filters: filters
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET un score spécifique par ID
router.get('/:id', async (req, res) => {
  try {
    const score = await req.db.collection('scores').findOne({ 
      _id: new ObjectId(req.params.id) 
    });
    
    if (!score) {
      return res.status(404).json({ success: false, message: 'Score non trouvé' });
    }
    
    res.json({ success: true, score });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST créer un nouveau score
router.post('/', async (req, res) => {
  try {
    const { user_id, cycle_id, rotation_id, scores } = req.body;

    // Validation des champs requis
    if (!user_id || !cycle_id || !rotation_id || scores === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Les champs user_id, cycle_id, rotation_id et scores sont requis'
      });
    }

    // Vérifier que le score est un nombre
    if (typeof scores !== 'number') {
      return res.status(400).json({
        success: false,
        message: 'Le score doit être un nombre'
      });
    }

    const scoreData = {
      user_id,
      cycle_id,
      rotation_id,
      scores,
      created_at: new Date(),
      updated_at: new Date()
    };

    const result = await req.db.collection('scores').insertOne(scoreData);
    
    res.status(201).json({
      success: true,
      id: result.insertedId,
      message: 'Score créé avec succès'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT modifier un score
router.put('/:id', async (req, res) => {
  try {
    const { user_id, cycle_id, rotation_id, scores } = req.body;

    const updateData = {
      updated_at: new Date()
    };

    if (user_id) updateData.user_id = user_id;
    if (cycle_id) updateData.cycle_id = cycle_id;
    if (rotation_id) updateData.rotation_id = rotation_id;
    if (scores !== undefined) {
      if (typeof scores !== 'number') {
        return res.status(400).json({
          success: false,
          message: 'Le score doit être un nombre'
        });
      }
      updateData.scores = scores;
    }

    const result = await req.db.collection('scores').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Score non trouvé' });
    }

    res.json({ success: true, message: 'Score mis à jour avec succès' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE supprimer un score
router.delete('/:id', async (req, res) => {
  try {
    const result = await req.db.collection('scores').deleteOne({ 
      _id: new ObjectId(req.params.id) 
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Score non trouvé' });
    }

    res.json({ success: true, message: 'Score supprimé avec succès' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Routes supplémentaires pour des statistiques

// GET scores par utilisateur
router.get('/user/:userId', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const scores = await req.db.collection('scores')
      .find({ user_id: req.params.userId })
      .sort({ _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const total = await req.db.collection('scores').countDocuments({ 
      user_id: req.params.userId 
    });

    res.json({
      success: true,
      scores,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET scores par cycle
router.get('/cycle/:cycleId', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const scores = await req.db.collection('scores')
      .find({ cycle_id: req.params.cycleId })
      .sort({ _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const total = await req.db.collection('scores').countDocuments({ 
      cycle_id: req.params.cycleId 
    });

    res.json({
      success: true,
      scores,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET un score spécifique par ID
router.get('/:id', async (req, res) => {
  try {
    const score = await req.db.collection('scores').findOne({ 
      _id: new ObjectId(req.params.id) 
    });
    
    if (!score) {
      return res.status(404).json({ success: false, message: 'Score non trouvé' });
    }
    
    res.json({ success: true, score });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST créer un nouveau score
router.post('/', async (req, res) => {
  try {
    const { user_id, cycle_id, rotation_id, scores } = req.body;

    // Validation des champs requis
    if (!user_id || !cycle_id || !rotation_id || scores === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Les champs user_id, cycle_id, rotation_id et scores sont requis'
      });
    }

    // Vérifier que le score est un nombre
    if (typeof scores !== 'number') {
      return res.status(400).json({
        success: false,
        message: 'Le score doit être un nombre'
      });
    }

    const scoreData = {
      user_id,
      cycle_id,
      rotation_id,
      scores,
      created_at: new Date(),
      updated_at: new Date()
    };

    const result = await req.db.collection('scores').insertOne(scoreData);
    
    res.status(201).json({
      success: true,
      id: result.insertedId,
      message: 'Score créé avec succès'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT modifier un score
router.put('/:id', async (req, res) => {
  try {
    const { user_id, cycle_id, rotation_id, scores } = req.body;

    const updateData = {
      updated_at: new Date()
    };

    if (user_id) updateData.user_id = user_id;
    if (cycle_id) updateData.cycle_id = cycle_id;
    if (rotation_id) updateData.rotation_id = rotation_id;
    if (scores !== undefined) {
      if (typeof scores !== 'number') {
        return res.status(400).json({
          success: false,
          message: 'Le score doit être un nombre'
        });
      }
      updateData.scores = scores;
    }

    const result = await req.db.collection('scores').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Score non trouvé' });
    }

    res.json({ success: true, message: 'Score mis à jour avec succès' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE supprimer un score
router.delete('/:id', async (req, res) => {
  try {
    const result = await req.db.collection('scores').deleteOne({ 
      _id: new ObjectId(req.params.id) 
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Score non trouvé' });
    }

    res.json({ success: true, message: 'Score supprimé avec succès' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Routes supplémentaires pour des statistiques

// GET scores par utilisateur
router.get('/user/:userId', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const scores = await req.db.collection('scores')
      .find({ user_id: req.params.userId })
      .sort({ _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const total = await req.db.collection('scores').countDocuments({ 
      user_id: req.params.userId 
    });

    res.json({
      success: true,
      scores,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET scores par cycle
router.get('/cycle/:cycleId', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const scores = await req.db.collection('scores')
      .find({ cycle_id: req.params.cycleId })
      .sort({ _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const total = await req.db.collection('scores').countDocuments({ 
      cycle_id: req.params.cycleId 
    });

    res.json({
      success: true,
      scores,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;