import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb, requireAdmin } from '../middleware/auth.js';
import { parsePaginationParams, buildPaginationMeta } from '../utils/pagination.js';
import { USER_SCORES_LOOKUP } from '../utils/projections.js';
import { notifyDiscord } from '../utils/notifyDiscord.js';
import { logger } from '../utils/logger.js';
import { sendServerError } from '../utils/httpErrors.js';

const router = express.Router();

router.use(requireDb);

// GET cycles with pagination
router.get('/', async (req, res) => {
  try {
    const { page, limit, skip } = parsePaginationParams(req.query);

    const cycles = await req.db.collection('cycles')
      .find()
      .sort({ year: -1 })
      .toArray();

    // Most recent first, by the start date of the first rotation
    cycles.sort((a, b) => {
      // Parses DD/MM/YYYY
      const parseDate = (dateStr) => {
        if (!dateStr) return new Date(0);
        const [day, month, year] = dateStr.split('/');
        return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
      };

      const dateA = a.rotations && a.rotations.length > 0 ? parseDate(a.rotations[0].start_date) : new Date(0);
      const dateB = b.rotations && b.rotations.length > 0 ? parseDate(b.rotations[0].start_date) : new Date(0);
      
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

// GET a cycle by id
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

// POST create a cycle
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, rotations } = req.body;

    // A cycle has exactly 20 rotations
    if (!rotations || rotations.length !== 20) {
      return res.status(400).json({
        success: false,
        message: 'Un cycle doit contenir exactement 20 rotations'
      });
    }

    const currentYear = new Date().getFullYear();

    // The name must be unique within a year (it can be reused across years; the year is part of the
    // podium resolution key)
    const existingCycle = await req.db.collection('cycles').findOne({ name, year: currentYear });
    if (existingCycle) {
      return res.status(409).json({
        success: false,
        message: `Un cycle nommé "${name}" existe déjà pour l'année ${currentYear}`
      });
    }

    // Rotations must be unique
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

    // Discord notification, awaited before responding (on Vercel, execution may stop once the
    // response is sent).
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

// PUT update a cycle
router.put('/:cycleId', requireAdmin, async (req, res) => {
  try {
    const { name, rotations } = req.body;

    // A cycle has exactly 20 rotations
    if (rotations && rotations.length !== 20) {
      return res.status(400).json({
        success: false,
        message: 'Un cycle doit contenir exactement 20 rotations'
      });
    }

    // Rotations must be unique (when provided)
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
      // Names can be reused across years: only a name+year duplicate is rejected (a cycle's year cannot
      // be changed through this route).
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
      // Keep existing ids, generate the missing ones
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

    // Discord notification, awaited before responding.
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

// DELETE a cycle
router.delete('/:cycleId', requireAdmin, async (req, res) => {
  try {
    const cycleToDelete = await req.db.collection('cycles').findOne({ _id: new ObjectId(req.params.cycleId) });

    const result = await req.db.collection('cycles').deleteOne({
      _id: new ObjectId(req.params.cycleId)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Cycle non trouvé' });
    }

    // Discord notification, awaited before responding.
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

// GET every score of a rotation, by its position in the cycle
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

    const guildName = req.query.guild; // Guild name filter

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

    const matchStage = {
      rotation_id: rotation.rotation_id,
      cycle_id: cycleId
    };

    if (guildId) {
      matchStage.guild_id = guildId;
    }

    // Every score first (no pagination) so ranks can be computed
    let pipelineForRanking = [
      { $match: matchStage },
      {
        $lookup: {
          from: 'users',
          let: { userId: "$user_id" },
          pipeline: [
            { 
              $match: { 
                $expr: { 
                  $or: [
                    { $eq: ["$discord_id", "$$userId"] }, // user_id holding a discord_id
                    { $eq: [{ $toString: "$_id" }, "$$userId"] } // user_id holding a stringified ObjectId
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
          preserveNullAndEmptyArrays: true // Keep scores whose user is not found
        }
      }
    ];

    pipelineForRanking.push(
      { $sort: { score: -1 } }
    );

    const allScores = await req.db.collection('scores')
      .aggregate(pipelineForRanking)
      .toArray();

    // Ranks with ties
    let currentRank = 1;
    let previousScore = null;

    const scoresWithRank = allScores.map((scoreDoc, index) => {
      if (previousScore !== null && scoreDoc.score !== previousScore) {
        currentRank = index + 1;
      }
      
      previousScore = scoreDoc.score;
      
      return {
        ...scoreDoc,
        rank: currentRank
      };
    });

    // Paginate the ranked results
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