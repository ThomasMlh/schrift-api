import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb, requireAdmin } from '../middleware/auth.js';
import { parsePaginationParams, buildPaginationMeta } from '../utils/pagination.js';
import { USER_SCORES_LOOKUP } from '../utils/projections.js';
import { notifyDiscord } from '../utils/notifyDiscord.js';
import { logger } from '../utils/logger.js';
import { sendServerError } from '../utils/httpErrors.js';

const router = express.Router();

// Middleware pour toutes les routes cycles
router.use(requireDb);

// GET tous les cycles avec pagination
router.get('/', async (req, res) => {
  try {
    const { page, limit, skip } = parsePaginationParams(req.query);

    const cycles = await req.db.collection('cycles')
      .find()
      .sort({ year: -1 })
      .toArray();

    // Trier les cycles par la start_date la plus récente (première rotation)
    cycles.sort((a, b) => {
      // Fonction pour parser le format DD/MM/YYYY
      const parseDate = (dateStr) => {
        if (!dateStr) return new Date(0);
        const [day, month, year] = dateStr.split('/');
        return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
      };

      const dateA = a.rotations && a.rotations.length > 0 ? parseDate(a.rotations[0].start_date) : new Date(0);
      const dateB = b.rotations && b.rotations.length > 0 ? parseDate(b.rotations[0].start_date) : new Date(0);
      
      // Tri décroissant (dates les plus récentes en premier)
      return dateB.getTime() - dateA.getTime();
    });

    const paginatedCycles = cycles.slice(skip, skip + limit);
    const totalCount = cycles.length;

    res.json({
      success: true,
      data: paginatedCycles,
      pagination: buildPaginationMeta(page, limit, totalCount, paginatedCycles.length)
    });
  } catch (err) {
    sendServerError(res, err);
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
    sendServerError(res, err);
  }
});

// POST créer un nouveau cycle
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, rotations } = req.body;

    // Validation : exactement 20 rotations
    if (!rotations || rotations.length !== 20) {
      return res.status(400).json({
        success: false,
        message: 'Un cycle doit contenir exactement 20 rotations'
      });
    }

    // Prendre l'année en cours
    const currentYear = new Date().getFullYear();

    // Validation : le nom doit être unique pour une même année (le nom peut être
    // réutilisé d'une année à l'autre, l'année sert de clé de résolution du podium)
    const existingCycle = await req.db.collection('cycles').findOne({ name, year: currentYear });
    if (existingCycle) {
      return res.status(409).json({
        success: false,
        message: `Un cycle nommé "${name}" existe déjà pour l'année ${currentYear}`
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
        alteration: rotation.alteration,
        position: rotation.position,
        rotation_id: rotation.rotation_id
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
      year: currentYear,
      created_at: new Date(),
      updated_at: new Date()
    };

    const result = await req.db.collection('cycles').insertOne(cycle);

    // Notification Discord — attendue avant la réponse (cf. commit fix(notify) : sur Vercel,
    // l'exécution peut être coupée dès la réponse envoyée).
    try {
      await notifyDiscord('cycle_change', {
        action: 'create',
        cycle_name: cycle.name,
        cycle_year: cycle.year,
        rotation_count: cycle.rotations.length
      });
    } catch (notifErr) {
      logger.error('[cycles/create] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.status(201).json({
      success: true,
      id: result.insertedId,
      message: 'Cycle créé avec succès'
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

// PUT modifier un cycle
router.put('/:cycleId', requireAdmin, async (req, res) => {
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
          alteration: rotation.alteration,
          position: rotation.position,
          rotation_id: rotation.rotation_id
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

    const currentCycle = await req.db.collection('cycles').findOne({ _id: new ObjectId(req.params.cycleId) });
    if (!currentCycle) {
      return res.status(404).json({ success: false, message: 'Cycle non trouvé' });
    }

    if (name) {
      // Le nom peut être réutilisé d'une année à l'autre : on ne bloque que le
      // doublon name+year (l'année d'un cycle n'est pas modifiable via cette route).
      const existingCycle = await req.db.collection('cycles').findOne({
        name,
        year: currentCycle.year,
        _id: { $ne: new ObjectId(req.params.cycleId) }
      });
      if (existingCycle) {
        return res.status(409).json({
          success: false,
          message: `Un cycle nommé "${name}" existe déjà pour l'année ${currentCycle.year}`
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

    // Notification Discord — attendue avant la réponse.
    try {
      await notifyDiscord('cycle_change', {
        action: 'update',
        cycle_name: updateData.name || currentCycle.name,
        cycle_year: currentCycle.year,
        rotation_count: (updateData.rotations || currentCycle.rotations).length
      });
    } catch (notifErr) {
      logger.error('[cycles/update] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.json({ success: true, message: 'Cycle mis à jour avec succès' });
  } catch (err) {
    sendServerError(res, err);
  }
});

// DELETE supprimer un cycle
router.delete('/:cycleId', requireAdmin, async (req, res) => {
  try {
    const cycleToDelete = await req.db.collection('cycles').findOne({ _id: new ObjectId(req.params.cycleId) });

    const result = await req.db.collection('cycles').deleteOne({
      _id: new ObjectId(req.params.cycleId)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Cycle non trouvé' });
    }

    // Notification Discord — attendue avant la réponse.
    try {
      await notifyDiscord('cycle_change', {
        action: 'delete',
        cycle_name: cycleToDelete.name,
        cycle_year: cycleToDelete.year,
        rotation_count: (cycleToDelete.rotations || []).length
      });
    } catch (notifErr) {
      logger.error('[cycles/delete] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.json({ success: true, message: 'Cycle supprimé avec succès' });
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET tout les scores d'une rotation donné par sa position dans un cycle donné par son ID
router.get('/:cycleId/rotations/:position/scores', async (req, res) => {
  try {
    const cycleId = req.params.cycleId;
    const position = parseInt(req.params.position);

    if (isNaN(position) || position < 1 || position > 20) {
      return res.status(400).json({ success: false, message: 'Position de rotation invalide. Doit être entre 1 et 20.' });
    }

    const { page, limit, skip } = parsePaginationParams(req.query);

    const cycle = await req.db.collection('cycles').findOne({ 
      _id: new ObjectId(cycleId) 
    });

    if (!cycle) {
      return res.status(404).json({ success: false, message: 'Cycle non trouvé' });
    }

    const rotation = cycle.rotations[position - 1];
    if (!rotation) {
      return res.status(404).json({ success: false, message: 'Rotation non trouvée pour cette position' });
    }

    const currentRotation = await req.db.collection('rotations').findOne({ _id: new ObjectId(rotation.rotation_id)});
    if(!currentRotation) {
      return res.status(404).json({ success: false, message: 'Rotation actuelle non trouvée' });
    }

    // Paramètres de query
    const guildName = req.query.guild; // Nom de la guilde à filtrer

    // Si guild_name est spécifié, rechercher la guilde correspondante
    let guildId = null;
    if (guildName && guildName.trim()) {
      const guild = await req.db.collection('guildes').findOne({
        name: guildName.trim()
      });

      if (!guild) {
        return res.status(404).json({
          success: false,
          message: `Guilde avec le nom "${guildName}" non trouvée`
        });
      }

      guildId = guild._id.toString();
    }

    // Construire le match stage avec le filtre guilde si nécessaire
    const matchStage = {
      rotation_id: rotation.rotation_id,
      cycle_id: cycleId
    };

    if (guildId) {
      matchStage.guild_id = guildId;
    }

    // Pipeline pour récupérer tous les scores (sans pagination d'abord pour calculer les ranks)
    let pipelineForRanking = [
      { $match: matchStage },
      {
        $lookup: {
          from: 'users',
          let: { userId: "$user_id" }, // Pas de conversion ObjectId ici
          pipeline: [
            { 
              $match: { 
                $expr: { 
                  $or: [
                    { $eq: ["$discord_id", "$$userId"] }, // Si user_id est un discord_id
                    { $eq: [{ $toString: "$_id" }, "$$userId"] } // Si user_id est un ObjectId en string
                  ]
                }
              }
            },
            { $project: USER_SCORES_LOOKUP }
          ],
          as: 'user'
        }
      },
      {
        $unwind: {
          path: '$user',
          preserveNullAndEmptyArrays: true // Garder les scores même si l'utilisateur n'est pas trouvé
        }
      }
    ];

    // Ajouter le tri (sans pagination pour le moment)
    pipelineForRanking.push(
      { $sort: { score: -1 } }
    );

    const allScores = await req.db.collection('scores')
      .aggregate(pipelineForRanking)
      .toArray();

    // Calculer les ranks en tenant compte des égalités
    let currentRank = 1;
    let previousScore = null;

    const scoresWithRank = allScores.map((scoreDoc, index) => {
      if (previousScore !== null && scoreDoc.score !== previousScore) {
        // Le score a changé, mettre à jour le rank
        currentRank = index + 1;
      }
      
      previousScore = scoreDoc.score;
      
      return {
        ...scoreDoc,
        rank: currentRank
      };
    });

    // Appliquer la pagination sur les résultats avec rank
    const totalCount = scoresWithRank.length;
    const scores = scoresWithRank.slice(skip, skip + limit);

    res.json({
      success: true,
      data: scores,
      cycle: cycle,
      rotation: currentRotation,
      filters: {
        guild: guildName || null
      },
      pagination: buildPaginationMeta(page, limit, totalCount, scores.length)
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;