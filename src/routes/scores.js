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
    const limit = parseInt(req.query.limit) || 50; // Harmonisé avec characters
    const skip = (page - 1) * limit;

    // Limiter le nombre max par page pour éviter les abus
    const maxLimit = 200;
    const actualLimit = Math.min(limit, maxLimit);

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
      .limit(actualLimit)
      .toArray();

    const totalCount = await req.db.collection('scores').countDocuments(filters);
    const totalPages = Math.ceil(totalCount / actualLimit);

    res.json({
      success: true,
      data: scores, // Changé de 'data' vers 'scores' pour cohérence
      pagination: {
        currentPage: page,
        totalPages,
        totalCount,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
        itemsPerPage: actualLimit,
        itemsOnPage: scores.length
      },
      // Retourner les filtres actifs pour le frontend
      activeFilters: {
        user_id: req.query.user_id || null,
        cycle_id: req.query.cycle_id || null,
        rotation_id: req.query.rotation_id || null
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

// POST créer plusieurs scores en lot (saisie groupée)
router.post('/bulk', async (req, res) => {
  try {
    const scores = req.body;

    // Validation du format
    if (!Array.isArray(scores) || scores.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Un tableau de scores est requis'
      });
    }

    // Validation de chaque score
    for (const score of scores) {
      const { user_id, cycle_id, rotation_id, guild_id, score: scoreValue } = score;

      if (!user_id || !cycle_id || !rotation_id || !guild_id || scoreValue === undefined) {
        return res.status(400).json({
          success: false,
          message: 'Chaque score doit contenir user_id, cycle_id, rotation_id, guild_id et score'
        });
      }

      if (typeof scoreValue !== 'number') {
        return res.status(400).json({
          success: false,
          message: 'Tous les scores doivent être des nombres'
        });
      }
    }

    // Vérifier les doublons dans la requête
    const duplicateCheck = new Set();
    for (const score of scores) {
      const key = `${score.user_id}-${score.cycle_id}-${score.rotation_id}`;
      if (duplicateCheck.has(key)) {
        return res.status(400).json({
          success: false,
          message: `Doublon détecté : l'utilisateur ${score.user_id} a plusieurs scores pour la même rotation ${score.rotation_id}`
        });
      }
      duplicateCheck.add(key);
    }

    // Identifier les scores existants et nouveaux
    const existingScores = new Map();
    for (const score of scores) {
      const existingScore = await req.db.collection('scores').findOne({
        user_id: score.user_id,
        cycle_id: score.cycle_id,
        rotation_id: score.rotation_id
      });

      if (existingScore) {
        existingScores.set(`${score.user_id}-${score.cycle_id}-${score.rotation_id}`, existingScore);
      }
    }

    // Récupérer le cycle pour avoir l'ordre des rotations
    const cycle = await req.db.collection('cycles').findOne({
      _id: new ObjectId(scores[0].cycle_id)
    });

    if (!cycle) {
      return res.status(400).json({
        success: false,
        message: 'Cycle non trouvé'
      });
    }

    // Créer un map des rotations avec leur index pour l'ordre
    const rotationIndexMap = new Map();
    cycle.rotations.forEach((rotation, index) => {
      rotationIndexMap.set(rotation._id.toString(), index);
    });

    // Préparer les scores finaux avec calculs différentiels
    const finalScores = [];

    for (const score of scores) {
      let finalScore = score.score;
      const currentRotationIndex = rotationIndexMap.get(score.rotation_id);

      // Logique de soustraction : 1 rotation sur 2 (index impairs)
      if (currentRotationIndex > 0 && currentRotationIndex % 2 === 1) {
        // Chercher le score de la rotation précédente pour ce user
        const previousRotationId = cycle.rotations[currentRotationIndex - 1]._id.toString();

        const previousScore = await req.db.collection('scores').findOne({
          user_id: score.user_id,
          cycle_id: score.cycle_id,
          rotation_id: previousRotationId
        });

        if (previousScore) {
          finalScore = score.score - previousScore.score;
        }
      }

      const scoreData = {
        user_id: score.user_id,
        cycle_id: score.cycle_id,
        rotation_id: score.rotation_id,
        guild_id: score.guild_id,
        score: finalScore,
        raw_score: score.score, // Conserver le score original
        is_differential: currentRotationIndex > 0 && currentRotationIndex % 2 === 1,
        created_at: new Date(),
        updated_at: new Date()
      };

      finalScores.push(scoreData);
    }

    // Traiter les scores avec upsert (insert ou update)
    let insertedCount = 0;
    let updatedCount = 0;
    const processedIds = [];

    for (const scoreData of finalScores) {
      const filter = {
        user_id: scoreData.user_id,
        cycle_id: scoreData.cycle_id,
        rotation_id: scoreData.rotation_id
      };

      const existingKey = `${scoreData.user_id}-${scoreData.cycle_id}-${scoreData.rotation_id}`;
      const isExisting = existingScores.has(existingKey);

      if (isExisting) {
        // Mettre à jour le score existant
        scoreData.updated_at = new Date();
        delete scoreData.created_at; // Ne pas modifier created_at lors d'une mise à jour

        const result = await req.db.collection('scores').updateOne(
          filter,
          { $set: scoreData }
        );

        if (result.matchedCount > 0) {
          updatedCount++;
          processedIds.push(existingScores.get(existingKey)._id);
        }
      } else {
        // Insérer un nouveau score
        const result = await req.db.collection('scores').insertOne(scoreData);
        if (result.insertedId) {
          insertedCount++;
          processedIds.push(result.insertedId);
        }
      }
    }

    res.status(200).json({
      success: true,
      insertedCount,
      updatedCount,
      totalProcessed: insertedCount + updatedCount,
      processedIds,
      message: `${insertedCount} scores créés et ${updatedCount} scores mis à jour avec succès`,
      details: {
        totalScores: finalScores.length,
        differentialScores: finalScores.filter(s => s.is_differential).length,
        directScores: finalScores.filter(s => !s.is_differential).length,
        newScores: insertedCount,
        updatedScores: updatedCount
      }
    });
  } catch (err) {
    console.error('Erreur lors de la saisie groupée:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST créer un nouveau score
router.post('/', async (req, res) => {
  try {
    const { user_id, cycle_id, rotation_id, guild_id, score } = req.body;

    // Validation des champs requis
    if (!user_id || !cycle_id || !rotation_id || !guild_id || score === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Les champs user_id, cycle_id, rotation_id, guild_id et score sont requis'
      });
    }

    // Vérifier que le score est un nombre
    if (typeof score !== 'number') {
      return res.status(400).json({
        success: false,
        message: 'Le score doit être un nombre'
      });
    }

    const scoreData = {
      user_id,
      cycle_id,
      rotation_id,
      guild_id,
      score,
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
    const { user_id, cycle_id, rotation_id, guild_id, score } = req.body;

    const updateData = {
      updated_at: new Date()
    };

    if (user_id) updateData.user_id = user_id;
    if (cycle_id) updateData.cycle_id = cycle_id;
    if (rotation_id) updateData.rotation_id = rotation_id;
    if (guild_id) updateData.guild_id = guild_id;
    if (score !== undefined) {
      if (typeof score !== 'number') {
        return res.status(400).json({
          success: false,
          message: 'Le score doit être un nombre'
        });
      }
      updateData.score = score;
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
    const limit = parseInt(req.query.limit) || 50; // Harmonisé avec characters
    const skip = (page - 1) * limit;

    // Limiter le nombre max par page pour éviter les abus
    const maxLimit = 200;
    const actualLimit = Math.min(limit, maxLimit);

    const scores = await req.db.collection('scores')
      .find({ user_id: req.params.userId })
      .sort({ _id: -1 })
      .skip(skip)
      .limit(actualLimit)
      .toArray();

    const totalCount = await req.db.collection('scores').countDocuments({
      user_id: req.params.userId
    });

    const totalPages = Math.ceil(totalCount / actualLimit);

    res.json({
      success: true,
      scores, // Changé de 'data' vers 'scores' pour cohérence
      pagination: {
        currentPage: page,
        totalPages,
        totalCount,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
        itemsPerPage: actualLimit,
        itemsOnPage: scores.length
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
    const limit = parseInt(req.query.limit) || 50; // Harmonisé avec characters
    const skip = (page - 1) * limit;

    // Limiter le nombre max par page pour éviter les abus
    const maxLimit = 200;
    const actualLimit = Math.min(limit, maxLimit);

    const scores = await req.db.collection('scores')
      .find({ cycle_id: req.params.cycleId })
      .sort({ _id: -1 })
      .skip(skip)
      .limit(actualLimit)
      .toArray();

    const totalCount = await req.db.collection('scores').countDocuments({
      cycle_id: req.params.cycleId
    });

    const totalPages = Math.ceil(totalCount / actualLimit);

    res.json({
      success: true,
      scores, // Changé de 'data' vers 'scores' pour cohérence
      pagination: {
        currentPage: page,
        totalPages,
        totalCount,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
        itemsPerPage: actualLimit,
        itemsOnPage: scores.length
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;