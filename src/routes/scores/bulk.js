import express from "express";
import { ObjectId } from "mongodb";
import { requireScoresAccess } from "../../middleware/auth.js";
import { notifyDiscord } from "../../utils/notifyDiscord.js";
import { buildRotationIndexMap, computeDifferential, recalculateAffectedDifferentials } from "../../services/scoreDifferential.js";
import { notifyPersonalRecords } from "../../services/killerRecords.js";
import { recordScoreChange } from "../../services/scoreHistory.js";
import { notifyAchievementUnlocks } from "../../services/achievementAnnouncements.js";
import { getUserDisplayName } from "../../utils/nameMatching.js";
import { USER_DISPLAY, USER_DISPLAY_WITH_ID } from "../../utils/projections.js";
import { resolveScoreAccounts } from "../../utils/bbsAccounts.js";
import { logger } from '../../utils/logger.js';
import { sendStatusCodeError } from '../../utils/httpErrors.js';

const router = express.Router();

// POST create scores in bulk (bulk entry)
router.post("/bulk", requireScoresAccess, async (req, res) => {
  try {
    const scores = req.body;

    if (!Array.isArray(scores) || scores.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Un tableau de scores est requis"
      });
    }

    // Validate each score and collect the guilds
    const guildIds = new Set();
    for (const score of scores) {
      const { user_id, cycle_id, rotation_id, guild_id, bbs_id, raw_score } = score;

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
            "Chaque score doit contenir user_id, bbs_id, cycle_id, rotation_id, guild_id et raw_score"
        });
      }

      if (typeof raw_score !== "number") {
        return res.status(400).json({
          success: false,
          message: "Tous les raw_score doivent être des nombres"
        });
      }

      guildIds.add(guild_id);
    }

    if (!req.user.hasFullAccess) {
      // Leaders/officers can only submit scores for guilds they manage
      const allowedGuildIds = req.user.allowedGuildIds || [];
      const invalidGuilds = Array.from(guildIds).filter(guildId => !allowedGuildIds.includes(guildId));

      if (invalidGuilds.length > 0) {
        return res.status(403).json({
          success: false,
          message: `Accès refusé. En tant que ${req.user.role}, vous ne pouvez saisir des scores que pour vos guildes (${allowedGuildIds.join(', ')}). Guildes non autorisées détectées : ${invalidGuilds.join(', ')}`
        });
      }
    }

    // Each bbs_id must belong to the target user_id and guild
    const accountMap = await resolveScoreAccounts(req.db, scores);

    // Reject duplicates within the request
    const duplicateCheck = new Set();
    for (const score of scores) {
      const key = `${score.bbs_id}-${score.cycle_id}-${score.rotation_id}`;
      if (duplicateCheck.has(key)) {
        return res.status(400).json({
          success: false,
          message: `Doublon détecté : le compte ${score.bbs_id} a plusieurs scores pour la même rotation ${score.rotation_id}`
        });
      }
      duplicateCheck.add(key);
    }

    // Split existing and new scores, matched on {bbs_id, cycle_id, rotation_id} only (not user_id): a
    // transferred account keeps its old scores under the previous user_id, so filtering on it too would
    // miss the existing score and create a duplicate.
    const existingScores = new Map();
    for (const score of scores) {
      const existingScore = await req.db.collection("scores").findOne({
        bbs_id: score.bbs_id,
        cycle_id: score.cycle_id,
        rotation_id: score.rotation_id
      });

      if (existingScore) {
        existingScores.set(
          `${score.bbs_id}-${score.cycle_id}-${score.rotation_id}`,
          existingScore
        );
      }
    }

    // The cycle gives the rotation order
    const cycle = await req.db.collection("cycles").findOne({
      _id: new ObjectId(scores[0].cycle_id)
    });

    if (!cycle) {
      return res.status(400).json({
        success: false,
        message: "Cycle non trouvé"
      });
    }

    const rotationIndexMap = buildRotationIndexMap(cycle);

    // Process scores in rotation order so base scores come before their differentials
    const sortedScores = scores.sort((a, b) => {
      const indexA = rotationIndexMap.get(a.rotation_id) || 0;
      const indexB = rotationIndexMap.get(b.rotation_id) || 0;
      return indexA - indexB;
    });

    const finalScores = [];
    // Raw scores of the current batch, keyed by bbs_id and rotation_id
    const currentBatchScores = new Map();

    for (const score of sortedScores) {
      const rawScore = score.raw_score;
      const currentRotationIndex = rotationIndexMap.get(score.rotation_id);

      // Look for the previous score in the current batch first, then in the database
      const previousRotationId = currentRotationIndex > 0
        ? cycle.rotations[currentRotationIndex - 1].rotation_id
        : null;
      let previousRawScore = previousRotationId
        ? currentBatchScores.get(`${score.bbs_id}-${previousRotationId}`)
        : undefined;
      if (previousRawScore === undefined && previousRotationId) {
        const prevScore = await req.db.collection("scores").findOne({
          bbs_id: score.bbs_id, cycle_id: score.cycle_id, rotation_id: previousRotationId
        });
        if (prevScore) previousRawScore = prevScore.raw_score;
      }

      const { score: finalScore, isDifferential } = computeDifferential(rawScore, currentRotationIndex, previousRawScore);
      const account = accountMap.get(`${score.user_id}-${score.bbs_id}`);

      const scoreData = {
        user_id: score.user_id,
        bbs_id: score.bbs_id,
        bbs_name: account?.bbs_name || null,
        cycle_id: score.cycle_id,
        rotation_id: score.rotation_id,
        guild_id: score.guild_id,
        raw_score: rawScore,
        score: finalScore,
        is_differential: isDifferential,
        created_at: new Date(),
        updated_at: new Date()
      };

      finalScores.push(scoreData);

      const currentKey = `${score.bbs_id}-${score.rotation_id}`;
      currentBatchScores.set(currentKey, rawScore);
    }

    // Upsert each score
    let insertedCount = 0;
    let updatedCount = 0;
    let recalculatedCount = 0;
    const processedIds = [];
    const recalculatedIds = [];
    // Newly created scores only (not updates): the only personal record candidates, so re-entering an
    // existing score does not celebrate again.
    const insertedScores = [];

    for (const scoreData of finalScores) {
      // bbs_id is the score identity, not user_id (see above): the filter finds the document even when
      // it still holds the user_id from before an account transfer, and the $set below updates it.
      const filter = {
        bbs_id: scoreData.bbs_id,
        cycle_id: scoreData.cycle_id,
        rotation_id: scoreData.rotation_id
      };

      const existingKey = `${scoreData.bbs_id}-${scoreData.cycle_id}-${scoreData.rotation_id}`;
      const isExisting = existingScores.has(existingKey);
      const currentRotationIndex = rotationIndexMap.get(scoreData.rotation_id);

      if (isExisting) {
        scoreData.updated_at = new Date();
        delete scoreData.created_at; // Keep created_at on update

        const result = await req.db
          .collection("scores")
          .updateOne(filter, { $set: scoreData });

        if (result.matchedCount > 0) {
          updatedCount++;
          processedIds.push(existingScores.get(existingKey)._id);
          await recordScoreChange(req.db, { action: 'update', source: 'bulk', before: existingScores.get(existingKey), after: scoreData, user: req.user });
        }
      } else {
        const result = await req.db.collection("scores").insertOne(scoreData);
        if (result.insertedId) {
          insertedCount++;
          processedIds.push(result.insertedId);
          insertedScores.push(scoreData);
          await recordScoreChange(req.db, { action: 'create', source: 'bulk', scoreId: result.insertedId, after: scoreData, user: req.user });
        }
      }

      // A base score (even index) triggers a recomputation of the following differentials
      if (currentRotationIndex % 2 === 0) {
        const affectedIds = await recalculateAffectedDifferentials(req.db, cycle, currentRotationIndex, scoreData.cycle_id, scoreData.bbs_id);
        recalculatedIds.push(...affectedIds);
        recalculatedCount += affectedIds.length;
      }
    }

    // Discord notification (non-blocking)
    try {
      const userIds = [...new Set(finalScores.map(s => s.user_id))];
      const users = await req.db.collection("users").find({
        _id: { $in: userIds.map(id => new ObjectId(id)) }
      }, { projection: USER_DISPLAY_WITH_ID }).toArray();
      const userMap = new Map(users.map(u => [u._id.toString(), u]));

      // Guild name and Discord channels
      const firstGuildId = finalScores[0]?.guild_id;
      let guildName = "";
      let guildChannelId = "";
      let guildGeneralChannelId = "";
      if (firstGuildId) {
        const guild = await req.db.collection("guildes").findOne({ _id: new ObjectId(firstGuildId) });
        guildName = guild?.name || "";
        guildChannelId = guild?.discord_channel_id || "";
        guildGeneralChannelId = guild?.discord_general_channel_id || "";
      }

      // Rotation killer and attack type
      const firstRotationId = finalScores[0]?.rotation_id;
      const rotation = cycle.rotations.find(r => r.rotation_id === firstRotationId);
      const killer = rotation?.killer || "";
      const attack = rotation?.attack || "";

      const sortedForNotif = [...finalScores].sort((a, b) => b.score - a.score);
      const scoresForNotif = sortedForNotif.map((s, i) => {
        const user = userMap.get(s.user_id);
        const pseudo = s.bbs_name || getUserDisplayName(user, s.user_id);
        return { rank: i + 1, pseudo, score: s.score, raw_score: s.raw_score };
      });

      // Submitter's display name
      let submittedBy = "Inconnu";
      if (req.user?._id) {
        const submitter = await req.db.collection("users").findOne(
          { _id: new ObjectId(req.user._id) },
          { projection: USER_DISPLAY }
        );
        submittedBy = getUserDisplayName(submitter);
      }

      // Awaited before responding: on Vercel (serverless) execution may stop once the response is sent,
      // so an un-awaited call is not guaranteed to complete (podium captures used to go missing
      // intermittently). maxDuration=300s in vercel.json leaves room for the Playwright capture.
      await notifyDiscord("scores", {
        submitted_by: submittedBy,
        guild_name: guildName,
        cycle_name: cycle.name || "",
        killer,
        attack,
        scores: scoresForNotif,
        summary: `${insertedCount} créés, ${updatedCount} mis à jour, ${recalculatedCount} recalculés`
      }, guildChannelId);

      // Automatic podium capture (image) to the guild's members channel, in addition to the text summary
      // sent to the leaders channel above.
      if (process.env.FRONTEND_URL && guildName && rotation?.position !== undefined) {
        const cycleSlug = `${(cycle.name || "").toLowerCase().replace(/\s+/g, "-")}-${cycle.year}`;
        const captureUrl = `${process.env.FRONTEND_URL.replace(/\/$/, "")}/podium?capture=1&mode=rotation`
          + `&cycle_name=${encodeURIComponent(cycleSlug)}&rotation=${rotation.position}&guild_name=${encodeURIComponent(guildName)}`;

        await notifyDiscord("podium_snapshot", {
          guild_name: guildName,
          cycle_name: cycle.name || "",
          killer,
          attack,
          podium_url: captureUrl,
        }, guildGeneralChannelId || guildChannelId);
      }
    } catch (notifErr) {
      logger.error("[scores/bulk] Erreur notification Discord (non bloquant):", notifErr.message);
    }

    // Personal records beaten (one message per guild; never throws)
    await notifyPersonalRecords(req.db, insertedScores);
    // An update can also unlock an achievement: check every processed score
    await notifyAchievementUnlocks(req.db, finalScores);

    res.status(200).json({
      success: true,
      insertedCount,
      updatedCount,
      recalculatedCount,
      totalProcessed: insertedCount + updatedCount,
      processedIds,
      recalculatedIds,
      message: `${insertedCount} scores créés, ${updatedCount} scores mis à jour et ${recalculatedCount} scores différentiels recalculés avec succès`,
      details: {
        totalScores: finalScores.length,
        differentialScores: finalScores.filter((s) => s.is_differential).length,
        directScores: finalScores.filter((s) => !s.is_differential).length,
        newScores: insertedCount,
        updatedScores: updatedCount,
        recalculatedScores: recalculatedCount
      }
    });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors de la saisie groupée', "Erreur lors de la saisie groupée:");
  }
});

export default router;
