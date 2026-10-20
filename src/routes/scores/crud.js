import express from "express";
import { ObjectId } from "mongodb";
import { requireScoresAccess, canManageGuild } from "../../middleware/auth.js";
import { notifyDiscord } from "../../utils/notifyDiscord.js";
import { compareEntities } from "../../services/scoreComparison.js";
import { buildRotationIndexMap, computeDifferential, recalculateAffectedDifferentials } from "../../services/scoreDifferential.js";
import { notifyPersonalRecords } from "../../services/killerRecords.js";
import { recordScoreChange } from "../../services/scoreHistory.js";
import { notifyAchievementUnlocks } from "../../services/achievementAnnouncements.js";
import { getUserDisplayName } from "../../utils/nameMatching.js";
import { parsePaginationParams, buildPaginationMeta } from "../../utils/pagination.js";
import { USER_DISPLAY, USER_SCORES_LOOKUP } from "../../utils/projections.js";
import { resolveScoreAccounts } from "../../utils/bbsAccounts.js";
import { escapeRegex } from "../../utils/regexUtils.js";
import { logger } from '../../utils/logger.js';
import { sendServerError, sendStatusCodeError } from '../../utils/httpErrors.js';
import { rejectLockedCycles } from '../../services/scoreLock.js';

const router = express.Router();

// GET scores with filters and pagination
router.get("/", async (req, res) => {
  try {
    const { page, limit, skip } = parsePaginationParams(req.query);

    const filters = {};

    if (req.query.cycle_id) {
      filters.cycle_id = req.query.cycle_id;
    }

    if (req.query.rotation_id) {
      filters.rotation_id = req.query.rotation_id;
    }

    if (req.query.guild_id) {
      filters.guild_id = req.query.guild_id;
    }

    if (req.query.bbs_id) {
      filters.bbs_id = req.query.bbs_id;
    }

    // Searching by user name (global_name) requires an aggregation
    let pipeline = [];

    if (req.query.search && req.query.search.trim()) {
      const searchTerm = escapeRegex(req.query.search.trim());

      // Join users and filter on global_name
      pipeline = [
        { $match: filters },
        {
          $lookup: {
            from: "users",
            let: { userId: { $toObjectId: "$user_id" } },
            pipeline: [
              { $match: { $expr: { $eq: ["$_id", "$$userId"] } } },
              { $project: USER_SCORES_LOOKUP }
            ],
            as: "user"
          }
        },
        {
          $unwind: "$user"
        },
        {
          $match: {
            $or: [
              { "user.global_name": { $regex: searchTerm, $options: "i" } },
              { "user.username": { $regex: searchTerm, $options: "i" } },
              { "user.bbs_name": { $regex: searchTerm, $options: "i" } }
            ]
          }
        },
        { $sort: { _id: -1 } },
        { $skip: skip },
        { $limit: limit }
      ];
    } else {
      // No search, but still join the user data
      pipeline = [
        { $match: filters },
        {
          $lookup: {
            from: "users",
            let: { userId: { $toObjectId: "$user_id" } },
            pipeline: [
              { $match: { $expr: { $eq: ["$_id", "$$userId"] } } },
              {
                $project: {
                  _id: 1,
                  avatar: 1,
                  bbs_id: 1,
                  bbs_name: 1,
                  discord_id: 1,
                  global_name: 1,
                  guilde_id: 1,
                  role: 1,
                  username: 1
                }
              }
            ],
            as: "user"
          }
        },
        { $sort: { _id: -1 } },
        { $skip: skip },
        { $limit: limit }
      ];
    }

    const scores = await req.db
      .collection("scores")
      .aggregate(pipeline)
      .toArray();

    // Same logic for the count
    let totalCount;
    if (req.query.search && req.query.search.trim()) {
      const countSearchTerm = escapeRegex(req.query.search.trim());
      const countPipeline = [
        { $match: filters },
        {
          $lookup: {
            from: "users",
            let: { userId: { $toObjectId: "$user_id" } },
            pipeline: [
              { $match: { $expr: { $eq: ["$_id", "$$userId"] } } },
              {
                $project: {
                  _id: 1,
                  avatar: 1,
                  bbs_id: 1,
                  bbs_name: 1,
                  discord_id: 1,
                  global_name: 1,
                  guilde_id: 1,
                  role: 1,
                  username: 1
                }
              }
            ],
            as: "user"
          }
        },
        {
          $unwind: "$user"
        },
        {
          $match: {
            $or: [
              {
                "user.global_name": {
                  $regex: countSearchTerm,
                  $options: "i"
                }
              },
              {
                "user.username": {
                  $regex: countSearchTerm,
                  $options: "i"
                }
              },
              {
                "user.bbs_name": {
                  $regex: countSearchTerm,
                  $options: "i"
                }
              }
            ]
          }
        },
        { $count: "total" }
      ];

      const countResult = await req.db
        .collection("scores")
        .aggregate(countPipeline)
        .toArray();
      totalCount = countResult.length > 0 ? countResult[0].total : 0;
    } else {
      totalCount = await req.db.collection("scores").countDocuments(filters);
    }
    res.json({
      success: true,
      data: scores,
      pagination: buildPaginationMeta(page, limit, totalCount, scores.length),
      activeFilters: {
        cycle_id: req.query.cycle_id || null,
        rotation_id: req.query.rotation_id || null,
        guild_id: req.query.guild_id || null,
        search: req.query.search || null
      }
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET compare players or guilds
router.get("/compare", async (req, res) => {
  try {
    const { type, entity1, entity2, cycle_id, rotation_id } = req.query;

    // Required parameters
    if (!type || !entity1 || !entity2) {
      return res.status(400).json({
        success: false,
        message: "Les paramètres type, entity1 et entity2 sont obligatoires"
      });
    }

    if (type !== "players" && type !== "guilds") {
      return res.status(400).json({
        success: false,
        message: "Le type doit être 'players' ou 'guilds'"
      });
    }

    // Players are compared by ObjectId
    if (type === "players") {
      try {
        if (entity1) new ObjectId(entity1);
        if (entity2) new ObjectId(entity2);
      } catch (err) {
        return res.status(400).json({
          success: false,
          message: `ID invalide: ${err.message}`
        });
      }
    }

    const baseFilter = {};

    if (cycle_id && rotation_id) {
      // Cycle and rotation
      baseFilter.cycle_id = cycle_id;
      baseFilter.rotation_id = rotation_id;
    } else if (cycle_id) {
      // Cycle only
      baseFilter.cycle_id = cycle_id;
    } else if (rotation_id) {
      // Rotation only
      baseFilter.rotation_id = rotation_id;
    }
    // Neither cycle_id nor rotation_id: every score

    let comparisonResults;

    if (type === "players") {
      comparisonResults = await compareEntities(
        req.db,
        "user_id",
        entity1,
        entity2,
        baseFilter,
        { type: "players" }
      );
    } else {
      comparisonResults = await compareEntities(
        req.db,
        "guild_id",
        entity1,
        entity2,
        baseFilter,
        { type: "guilds" }
      );
    }

    res.json({
      success: true,
      comparison: comparisonResults,
      filters: {
        type,
        entity1,
        entity2,
        cycle_id: cycle_id || null,
        rotation_id: rotation_id || null
      }
    });
  } catch (err) {
    logger.error("Erreur dans route compare:", err);
    sendServerError(res, err);
  }
});

// GET a score by id
router.get("/:id", async (req, res) => {
  try {
    const score = await req.db.collection("scores").findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!score) {
      return res
        .status(404)
        .json({ success: false, message: "Score non trouvé" });
    }

    res.json({ success: true, score });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST create a score
router.post("/", requireScoresAccess, async (req, res) => {
  try {
    const { user_id, cycle_id, rotation_id, guild_id, bbs_id, raw_score } = req.body;

    // Required fields
    if (
      !user_id ||
      !cycle_id ||
      !rotation_id ||
      !guild_id ||
      !bbs_id ||
      raw_score === undefined
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Les champs user_id, bbs_id, cycle_id, rotation_id, guild_id et raw_score sont requis"
      });
    }

    if (typeof raw_score !== "number") {
      return res.status(400).json({
        success: false,
        message: "Le raw_score doit être un nombre"
      });
    }

    // Leaders/officers can only write scores for guilds they manage
    if (!canManageGuild(req.user, guild_id)) {
      return res.status(403).json({
        success: false,
        message: `Accès refusé. En tant que ${req.user.role}, vous ne pouvez saisir des scores que pour vos guildes.`
      });
    }
    if (await rejectLockedCycles(req, res, [cycle_id])) return;

    // The bbs_id must belong to the target user_id and guild
    const accountMap = await resolveScoreAccounts(req.db, [{ user_id, bbs_id, guild_id }]);
    const account = accountMap.get(`${user_id}-${bbs_id}`);

    // The cycle gives the rotation order
    const cycle = await req.db.collection("cycles").findOne({
      _id: new ObjectId(cycle_id)
    });

    if (!cycle) {
      return res.status(400).json({
        success: false,
        message: "Cycle non trouvé"
      });
    }

    // The rotation must belong to the cycle
    const rotationExists = cycle.rotations.some(
      (rotation) => rotation.rotation_id === rotation_id
    );
    if (!rotationExists) {
      return res.status(400).json({
        success: false,
        message: "La rotation spécifiée n'appartient pas au cycle donné"
      });
    }

    const rotationIndexMap = buildRotationIndexMap(cycle);

    // Existing score for this account/cycle/rotation, matched on bbs_id (a transferred account keeps
    // its old scores under another user_id, filtering on it too would miss them)
    const existingScore = await req.db.collection("scores").findOne({
      bbs_id: bbs_id,
      cycle_id: cycle_id,
      rotation_id: rotation_id
    });

    if (existingScore) {
      return res.status(400).json({
        success: false,
        message: `Un score existe déjà pour ce compte dans la rotation #${
          rotationIndexMap.get(rotation_id) + 1
        } du ${cycle.name}`
      });
    }

    const currentRotationIndex = rotationIndexMap.get(rotation_id);

    // Previous score for the differential computation
    let previousRawScore;
    if (currentRotationIndex > 0) {
      const previousRotationId = cycle.rotations[currentRotationIndex - 1].rotation_id;
      const previousScore = await req.db.collection("scores").findOne({
        bbs_id, cycle_id, rotation_id: previousRotationId
      });
      if (previousScore) previousRawScore = previousScore.raw_score;
    }

    const { score: finalScore, isDifferential } = computeDifferential(raw_score, currentRotationIndex, previousRawScore);

    const scoreData = {
      user_id,
      bbs_id,
      bbs_name: account?.bbs_name || null,
      cycle_id,
      rotation_id,
      guild_id,
      raw_score,
      score: finalScore,
      is_differential: isDifferential,
      created_at: new Date(),
      updated_at: new Date()
    };

    const result = await req.db.collection("scores").insertOne(scoreData);
    await recordScoreChange(req.db, { action: 'create', scoreId: result.insertedId, after: scoreData, user: req.user });

    // A base score triggers a recomputation of the following differentials
    let recalculatedCount = 0;
    if (currentRotationIndex % 2 === 0) {
      const affectedIds = await recalculateAffectedDifferentials(req.db, cycle, currentRotationIndex, cycle_id, bbs_id);
      recalculatedCount = affectedIds.length;
    }

    // Personal record beaten (never throws). Not on PUT /:id: a leader correcting a score must not
    // trigger congratulations.
    await notifyPersonalRecords(req.db, [scoreData]);
    await notifyAchievementUnlocks(req.db, [scoreData]);

    res.status(201).json({
      success: true,
      id: result.insertedId,
      message: "Score créé avec succès" + (recalculatedCount > 0 ? ` et ${recalculatedCount} scores différentiels recalculés` : ""),
      details: {
        finalScore: finalScore,
        rawScore: raw_score,
        isDifferential: isDifferential,
        rotationIndex: currentRotationIndex,
        recalculatedCount: recalculatedCount
      }
    });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de la création du score', "Erreur lors de la création du score:");
  }
});

// PUT update a score
router.put("/:id", requireScoresAccess, async (req, res) => {
  try {
    const { user_id, bbs_id, cycle_id, rotation_id, guild_id, score } = req.body;

    const existingScore = await req.db.collection("scores").findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!existingScore) {
      return res
        .status(404)
        .json({ success: false, message: "Score non trouvé" });
    }

    // Leaders/officers need access to the current guild AND the target guild when it changes
    const targetGuildId = guild_id || existingScore.guild_id;
    if (!canManageGuild(req.user, existingScore.guild_id) || !canManageGuild(req.user, targetGuildId)) {
      return res.status(403).json({
        success: false,
        message: `Accès refusé. En tant que ${req.user.role}, vous ne pouvez modifier que des scores de vos guildes.`
      });
    }
    if (await rejectLockedCycles(req, res, [existingScore.cycle_id, cycle_id])) return;

    const updateData = {
      updated_at: new Date()
    };

    if (user_id) updateData.user_id = user_id;
    if (bbs_id) updateData.bbs_id = bbs_id;
    if (cycle_id) updateData.cycle_id = cycle_id;
    if (rotation_id) updateData.rotation_id = rotation_id;
    if (guild_id) updateData.guild_id = guild_id;

    // When user_id or bbs_id change, check again that the account belongs to the target user
    if (user_id || bbs_id) {
      const targetUserId = user_id || existingScore.user_id;
      const targetBbsId = bbs_id || existingScore.bbs_id;
      const accountMap = await resolveScoreAccounts(req.db, [{
        user_id: targetUserId, bbs_id: targetBbsId, guild_id: guild_id || existingScore.guild_id
      }]);
      const account = accountMap.get(`${targetUserId}-${targetBbsId}`);
      if (account?.bbs_name) updateData.bbs_name = account.bbs_name;

      // Moving to another account (different bbs_id): the target account must not already have a score
      // on this rotation, otherwise it would be silently overwritten.
      if (targetBbsId !== existingScore.bbs_id) {
        const targetCycleId = cycle_id || existingScore.cycle_id;
        const targetRotationId = rotation_id || existingScore.rotation_id;
        const duplicate = await req.db.collection("scores").findOne({
          bbs_id: targetBbsId,
          cycle_id: targetCycleId,
          rotation_id: targetRotationId,
          _id: { $ne: existingScore._id }
        });
        if (duplicate) {
          return res.status(400).json({
            success: false,
            message: `Le compte cible a déjà un score sur cette rotation (${duplicate.score.toLocaleString()})`
          });
        }
      }
    }

    // A changed score means recomputing raw_score with the differential logic
    if (score !== undefined) {
      if (typeof score !== "number") {
        return res.status(400).json({
          success: false,
          message: "Le score doit être un nombre"
        });
      }

      const targetCycleId = cycle_id || existingScore.cycle_id;
      const targetRotationId = rotation_id || existingScore.rotation_id;
      const targetBbsId = bbs_id || existingScore.bbs_id;

      const cycle = await req.db.collection("cycles").findOne({
        _id: new ObjectId(targetCycleId)
      });

      if (!cycle) {
        return res.status(400).json({
          success: false,
          message: "Cycle non trouvé"
        });
      }

      const rotationIndexMap = buildRotationIndexMap(cycle);

      const currentRotationIndex = rotationIndexMap.get(targetRotationId);
      let calculatedRawScore = score;
      let isDifferential = false;

      // Differential rotation (odd index): recompute raw_score
      if (currentRotationIndex > 0 && currentRotationIndex % 2 === 1) {
        const previousRotationId =
          cycle.rotations[currentRotationIndex - 1].rotation_id;

        const previousScore = await req.db.collection("scores").findOne({
          bbs_id: targetBbsId,
          cycle_id: targetCycleId,
          rotation_id: previousRotationId
        });

        if (previousScore) {
          // raw_score = score + previous raw_score
          calculatedRawScore = score + previousScore.raw_score;
          isDifferential = true;
        }
      }

      updateData.score = score;
      updateData.raw_score = calculatedRawScore;
      updateData.is_differential = isDifferential;
    }

    const result = await req.db
      .collection("scores")
      .updateOne({ _id: new ObjectId(req.params.id) }, { $set: updateData });

    if (result.matchedCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Score non trouvé" });
    }
    await recordScoreChange(req.db, { action: 'update', before: existingScore, after: updateData, user: req.user });

    // A changed base score triggers a recomputation of the following differentials
    let recalculatedCount = 0;
    if (score !== undefined) {
      const targetCycleId = cycle_id || existingScore.cycle_id;
      const targetBbsId = bbs_id || existingScore.bbs_id;
      const targetRotationId = rotation_id || existingScore.rotation_id;

      const cycle = await req.db.collection("cycles").findOne({
        _id: new ObjectId(targetCycleId)
      });

      if (cycle) {
        const rotationIndexMap = buildRotationIndexMap(cycle);
        const currentRotationIndex = rotationIndexMap.get(targetRotationId);

        if (currentRotationIndex % 2 === 0) { // Base score changed
          const affectedIds = await recalculateAffectedDifferentials(req.db, cycle, currentRotationIndex, targetCycleId, targetBbsId);
          recalculatedCount = affectedIds.length;
        }
      }
    }

    // Discord notification (non-blocking)
    if (score !== undefined) {
      try {
        const targetUserId = user_id || existingScore.user_id;
        const targetGuildId = guild_id || existingScore.guild_id;

        const editedUser = await req.db.collection('users').findOne(
          { _id: new ObjectId(targetUserId) },
          { projection: USER_DISPLAY }
        );
        const pseudo = updateData.bbs_name || existingScore.bbs_name || getUserDisplayName(editedUser, targetUserId);

        const guild = await req.db.collection('guildes').findOne({ _id: new ObjectId(targetGuildId) });
        const guildName = guild?.name || '';
        const guildChannelId = guild?.discord_channel_id || '';

        let submittedBy = 'Inconnu';
        if (req.user?._id) {
          const submitter = await req.db.collection('users').findOne(
            { _id: new ObjectId(req.user._id) },
            { projection: USER_DISPLAY }
          );
          submittedBy = getUserDisplayName(submitter);
        }

        const targetRotationId = rotation_id || existingScore.rotation_id;
        const targetCycleId = cycle_id || existingScore.cycle_id;

        const rotation = await req.db.collection('rotations').findOne(
          { _id: new ObjectId(targetRotationId) },
          { projection: { position: 1, attack: 1, killer: 1, alteration: 1 } }
        );
        const cycleDoc = await req.db.collection('cycles').findOne(
          { _id: new ObjectId(targetCycleId) },
          { projection: { name: 1 } }
        );

        await notifyDiscord('score_edit', {
          submitted_by: submittedBy,
          guild_name: guildName,
          pseudo,
          old_score: existingScore.score,
          new_score: updateData.score,
          raw_score: updateData.raw_score,
          is_differential: updateData.is_differential,
          recalculated_count: recalculatedCount,
          cycle_name: cycleDoc?.name || '',
          rotation_position: rotation?.position ?? null,
          rotation_attack: rotation?.attack || '',
          rotation_killer: rotation?.killer || ''
        }, guildChannelId);
      } catch (notifErr) {
        logger.error('[scores/edit] Erreur notification Discord (non bloquant):', notifErr.message);
      }
    }

    res.json({
      success: true,
      message: "Score mis à jour avec succès" + (recalculatedCount > 0 ? ` et ${recalculatedCount} scores différentiels recalculés` : ""),
      details:
        score !== undefined
          ? {
              finalScore: updateData.score,
              rawScore: updateData.raw_score,
              isDifferential: updateData.is_differential,
              recalculatedCount: recalculatedCount
            }
          : { recalculatedCount: recalculatedCount }
    });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de la mise à jour du score', "Erreur lors de la mise à jour du score:");
  }
});

// DELETE a score (admin, or a leader/officer for a score of their guild)
router.delete("/:id", requireScoresAccess, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "ID de score invalide" });
    }
    const existingScore = await req.db.collection("scores").findOne({ _id: new ObjectId(req.params.id) });
    if (!existingScore) {
      return res.status(404).json({ success: false, message: "Score non trouvé" });
    }
    if (!canManageGuild(req.user, existingScore.guild_id)) {
      return res.status(403).json({
        success: false,
        message: `Accès refusé. En tant que ${req.user.role}, vous ne pouvez supprimer que des scores de vos guildes.`
      });
    }
    if (await rejectLockedCycles(req, res, [existingScore.cycle_id])) return;

    const result = await req.db.collection("scores").deleteOne({ _id: existingScore._id });

    if (result.deletedCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Score non trouvé" });
    }
    await recordScoreChange(req.db, { action: 'delete', before: existingScore, user: req.user });

    res.json({ success: true, message: "Score supprimé avec succès" });
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET scores of a user
router.get("/user/:userId", async (req, res) => {
  try {
    const { page, limit, skip } = parsePaginationParams(req.query);

    const scores = await req.db
      .collection("scores")
      .find({ user_id: req.params.userId })
      .sort({ _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const totalCount = await req.db.collection("scores").countDocuments({
      user_id: req.params.userId
    });

    res.json({
      success: true,
      scores,
      pagination: buildPaginationMeta(page, limit, totalCount, scores.length)
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET scores of a cycle
router.get("/cycle/:cycleId", async (req, res) => {
  try {
    const { page, limit, skip } = parsePaginationParams(req.query);

    const scores = await req.db
      .collection("scores")
      .find({ cycle_id: req.params.cycleId })
      .sort({ _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const totalCount = await req.db.collection("scores").countDocuments({
      cycle_id: req.params.cycleId
    });

    res.json({
      success: true,
      scores,
      pagination: buildPaginationMeta(page, limit, totalCount, scores.length)
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;
