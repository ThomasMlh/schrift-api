import express from "express";
import { ObjectId } from "mongodb";
import { requireScoresAccess, canManageGuild } from "../../middleware/auth.js";
import { notifyDiscord } from "../../utils/notifyDiscord.js";
import { buildRotationIndexMap, recalculateAffectedDifferentials } from "../../services/scoreDifferential.js";
import { recordScoreChange } from "../../services/scoreHistory.js";
import { getUserDisplayName } from "../../utils/nameMatching.js";
import { USER_DISPLAY } from "../../utils/projections.js";
import { findAccount } from "../../utils/bbsAccounts.js";
import { logger } from '../../utils/logger.js';
import { sendServerError, sendStatusCodeError } from '../../utils/httpErrors.js';
import { rejectLockedCycles } from '../../services/scoreLock.js';

const router = express.Router();

// POST move the scores of a rotation to another rotation
router.post("/transfer-rotation", requireScoresAccess, async (req, res) => {
  try {
    const { cycle_id, source_rotation_id, target_rotation_id, dry_run } = req.body;
    let { guild_id } = req.body;

    if (!cycle_id || !source_rotation_id || !target_rotation_id) {
      return res.status(400).json({
        success: false,
        message: "cycle_id, source_rotation_id et target_rotation_id sont requis"
      });
    }

    if (source_rotation_id === target_rotation_id) {
      return res.status(400).json({
        success: false,
        message: "La rotation source et la rotation cible doivent être différentes"
      });
    }

    // Leaders/officers are restricted to a guild they manage
    if (!req.user.hasFullAccess) {
      const allowedGuildIds = req.user.allowedGuildIds || [];
      if (guild_id) {
        if (!canManageGuild(req.user, guild_id)) {
          return res.status(403).json({ success: false, message: `Accès refusé à la guilde ${guild_id}` });
        }
      } else if (allowedGuildIds.length === 1) {
        guild_id = allowedGuildIds[0];
      } else {
        return res.status(400).json({ success: false, message: "guild_id requis (vous gérez plusieurs guildes)" });
      }
    }
    if (await rejectLockedCycles(req, res, [cycle_id])) return;

    const cycle = await req.db.collection("cycles").findOne({
      _id: new ObjectId(cycle_id)
    });

    if (!cycle) {
      return res.status(400).json({ success: false, message: "Cycle non trouvé" });
    }

    const rotationIndexMap = buildRotationIndexMap(cycle);

    if (!rotationIndexMap.has(source_rotation_id)) {
      return res.status(400).json({ success: false, message: "La rotation source n'appartient pas à ce cycle" });
    }
    if (!rotationIndexMap.has(target_rotation_id)) {
      return res.status(400).json({ success: false, message: "La rotation cible n'appartient pas à ce cycle" });
    }

    const sourceIndex = rotationIndexMap.get(source_rotation_id);
    const targetIndex = rotationIndexMap.get(target_rotation_id);
    const parityChanged = (sourceIndex % 2) !== (targetIndex % 2);

    const sourceFilter = { rotation_id: source_rotation_id, cycle_id };
    if (guild_id) sourceFilter.guild_id = guild_id;

    const sourceScores = await req.db.collection("scores").find(sourceFilter).toArray();

    if (sourceScores.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Aucun score trouvé sur la rotation source avec ces critères"
      });
    }

    // Conflicts (existing scores on the target), reported only, not blocking
    const conflicts = [];
    for (const score of sourceScores) {
      const existing = await req.db.collection("scores").findOne({
        bbs_id: score.bbs_id,
        cycle_id,
        rotation_id: target_rotation_id
      });
      if (existing) {
        const user = await req.db.collection("users").findOne(
          { _id: new ObjectId(score.user_id) },
          { projection: { global_name: 1, username: 1, bbs_name: 1, discord_id: 1, avatar: 1 } }
        );
        conflicts.push({
          user_id: score.user_id,
          user: user || null,
          source_raw_score: score.raw_score,
          existing_raw_score: existing.raw_score
        });
      }
    }

    // New score of each entry, depending on the target rotation index
    const computeNewScore = async (score) => {
      if (targetIndex > 0 && targetIndex % 2 === 1) {
        const previousRotationId = cycle.rotations[targetIndex - 1].rotation_id;

        // Special case: the source IS the target's previous base rotation. After the transfer that rotation
        // is empty, so there is no base and score = raw_score (otherwise raw_score - raw_score = 0).
        if (previousRotationId !== source_rotation_id) {
          const prevScore = await req.db.collection("scores").findOne({
            bbs_id: score.bbs_id,
            cycle_id,
            rotation_id: previousRotationId
          });
          if (prevScore) {
            return {
              score: Math.max(0, score.raw_score - prevScore.raw_score),
              isDifferential: true
            };
          }
        }

        // No usable previous base: score = raw_score
        return { score: score.raw_score, isDifferential: true };
      }
      return { score: score.raw_score, isDifferential: false };
    };

    // Dry run: return the preview without changing anything
    if (dry_run) {
      const preview = [];
      for (const score of sourceScores) {
        const { score: newScore, isDifferential } = await computeNewScore(score);
        const user = await req.db.collection("users").findOne(
          { _id: new ObjectId(score.user_id) },
          { projection: { global_name: 1, username: 1, bbs_name: 1, discord_id: 1, avatar: 1 } }
        );
        preview.push({
          user_id: score.user_id,
          user: user || null,
          raw_score: score.raw_score,
          old_score: score.score,
          new_score: newScore,
          old_is_differential: score.is_differential,
          new_is_differential: isDifferential
        });
      }

      return res.json({
        success: true,
        dry_run: true,
        scoreCount: sourceScores.length,
        parityChanged,
        sourceIndex,
        targetIndex,
        conflicts,         // Warnings (scores that will be overwritten)
        preview
      });
    }

    // Actual transfer: in-place update, conflicts are overwritten
    let overwrittenCount = 0;
    for (const score of sourceScores) {
      const { score: newScore, isDifferential } = await computeNewScore(score);

      // Delete the player's existing score on the target first
      const existingTarget = await req.db.collection("scores").findOne({
        bbs_id: score.bbs_id,
        cycle_id,
        rotation_id: target_rotation_id
      });
      if (existingTarget) {
        await req.db.collection("scores").deleteOne({ _id: existingTarget._id });
        overwrittenCount++;
        await recordScoreChange(req.db, { action: 'delete', source: 'transfer_rotation', before: existingTarget, user: req.user });
      }

      // Update the source score in place (new rotation_id + recomputation)
      const transferUpdate = {
        rotation_id: target_rotation_id,
        score: newScore,
        is_differential: isDifferential,
        updated_at: new Date()
      };
      await req.db.collection("scores").updateOne({ _id: score._id }, { $set: transferUpdate });
      await recordScoreChange(req.db, { action: 'transfer_rotation', before: score, after: transferUpdate, user: req.user });
    }

    // A base target rotation (even index) triggers a recomputation of the following differentials
    let recalculatedCount = 0;
    if (targetIndex % 2 === 0) {
      const bbsIds = [...new Set(sourceScores.map(s => s.bbs_id))];
      for (const bbsId of bbsIds) {
        const ids = await recalculateAffectedDifferentials(req.db, cycle, targetIndex, cycle_id, bbsId);
        recalculatedCount += ids.length;
      }
    }

    // Discord notification per guild (non-blocking)
    try {
      const submitter = req.user?._id
        ? await req.db.collection("users").findOne(
            { _id: new ObjectId(req.user._id) },
            { projection: USER_DISPLAY }
          )
        : null;
      const submittedBy = getUserDisplayName(submitter);

      const sourceRotation = cycle.rotations.find(r => r.rotation_id === source_rotation_id);
      const targetRotation = cycle.rotations.find(r => r.rotation_id === target_rotation_id);
      const sourceLabel = sourceRotation
        ? `#${sourceIndex + 1} — ${sourceRotation.killer} ${sourceRotation.attack === "R" ? "🔴" : sourceRotation.attack === "B" ? "🔵" : "⚪"}`
        : `Rotation #${sourceIndex + 1}`;
      const targetLabel = targetRotation
        ? `#${targetIndex + 1} — ${targetRotation.killer} ${targetRotation.attack === "R" ? "🔴" : targetRotation.attack === "B" ? "🔵" : "⚪"}`
        : `Rotation #${targetIndex + 1}`;

      // One notification per guild
      const guildIds = [...new Set(sourceScores.map(s => s.guild_id))];
      for (const gId of guildIds) {
        const guild = await req.db.collection("guildes").findOne({ _id: new ObjectId(gId) });
        if (!guild?.discord_channel_id) continue;

        const guildScoreCount = sourceScores.filter(s => s.guild_id === gId).length;

        await notifyDiscord("rotation_transfer", {
          submitted_by: submittedBy,
          guild_name: guild.name || "",
          cycle_name: cycle.name || "",
          source_rotation: sourceLabel,
          target_rotation: targetLabel,
          transferred_count: guildScoreCount,
          overwritten_count: overwrittenCount,
          recalculated_count: recalculatedCount,
          parity_changed: parityChanged
        }, guild.discord_channel_id);
      }
    } catch (notifErr) {
      logger.error("[scores/transfer] Erreur notification Discord (non bloquant):", notifErr.message);
    }

    res.json({
      success: true,
      transferredCount: sourceScores.length,
      overwrittenCount,
      recalculatedCount,
      parityChanged,
      message: `${sourceScores.length} score(s) transféré(s) vers la rotation #${targetIndex + 1}` +
        (overwrittenCount > 0 ? `, ${overwrittenCount} écrasé(s)` : "") +
        (recalculatedCount > 0 ? `, ${recalculatedCount} différentiel(s) recalculé(s)` : ""),
      details: { sourceIndex, targetIndex, parityChanged, overwrittenCount }
    });

  } catch (err) {
    logger.error("Erreur lors du transfert de rotation:", err);
    sendServerError(res, err);
  }
});

// PUT reassign a score to another bbs account (e.g. a score entered under the wrong roster member).
// Unlike PUT /:id, the target account does NOT need to CURRENTLY belong to the score's guild: the
// point is to attach a past score to an account that has since changed guild. guild_id, cycle_id and
// rotation_id never change; only user_id/bbs_id/bbs_name do, and raw_score is recomputed from the
// target account's history when the rotation is differential (the displayed score is preserved).
router.put("/:id/transfer-account", requireScoresAccess, async (req, res) => {
  try {
    const { target_user_id, target_bbs_id } = req.body;

    if (!target_user_id || !target_bbs_id) {
      return res.status(400).json({ success: false, message: "target_user_id et target_bbs_id sont requis" });
    }

    const existingScore = await req.db.collection("scores").findOne({ _id: new ObjectId(req.params.id) });
    if (!existingScore) {
      return res.status(404).json({ success: false, message: "Score non trouvé" });
    }

    if (target_bbs_id === existingScore.bbs_id) {
      return res.status(400).json({ success: false, message: "Le compte cible doit être différent du compte source" });
    }

    // The score keeps its guild, so leader/officer rights are only checked on the existing score's guild.
    if (!canManageGuild(req.user, existingScore.guild_id)) {
      return res.status(403).json({
        success: false,
        message: `Accès refusé. En tant que ${req.user.role}, vous ne pouvez modifier que des scores de vos guildes.`
      });
    }
    if (await rejectLockedCycles(req, res, [existingScore.cycle_id])) return;

    const targetUser = await req.db.collection("users").findOne({ _id: new ObjectId(target_user_id) });
    if (!targetUser) {
      return res.status(404).json({ success: false, message: "Utilisateur cible non trouvé" });
    }
    // No guild check here (unlike resolveScoreAccounts): a transfer targets an account that may have
    // left the score's guild since.
    const targetAccount = findAccount(targetUser, target_bbs_id);
    if (!targetAccount) {
      return res.status(400).json({ success: false, message: "Ce compte bbs n'appartient pas à l'utilisateur cible" });
    }

    const duplicate = await req.db.collection("scores").findOne({
      bbs_id: target_bbs_id,
      cycle_id: existingScore.cycle_id,
      rotation_id: existingScore.rotation_id,
      _id: { $ne: existingScore._id }
    });
    if (duplicate) {
      return res.status(400).json({
        success: false,
        message: `Le compte cible a déjà un score sur cette rotation (${duplicate.score.toLocaleString()})`
      });
    }

    const cycle = await req.db.collection("cycles").findOne({ _id: new ObjectId(existingScore.cycle_id) });
    if (!cycle) {
      return res.status(400).json({ success: false, message: "Cycle non trouvé" });
    }

    const rotationIndexMap = buildRotationIndexMap(cycle);
    const currentRotationIndex = rotationIndexMap.get(existingScore.rotation_id);

    // Recompute raw_score from the TARGET account's history: the displayed score
    // (existingScore.score) is preserved, only its raw_score reference changes.
    let calculatedRawScore = existingScore.score;
    let isDifferential = false;
    if (currentRotationIndex > 0 && currentRotationIndex % 2 === 1) {
      const previousRotationId = cycle.rotations[currentRotationIndex - 1].rotation_id;
      const previousScore = await req.db.collection("scores").findOne({
        bbs_id: target_bbs_id, cycle_id: existingScore.cycle_id, rotation_id: previousRotationId
      });
      if (previousScore) {
        calculatedRawScore = existingScore.score + previousScore.raw_score;
        isDifferential = true;
      }
    }

    const updateData = {
      user_id: target_user_id,
      bbs_id: target_bbs_id,
      bbs_name: targetAccount.bbs_name || null,
      raw_score: calculatedRawScore,
      is_differential: isDifferential,
      updated_at: new Date()
    };

    await req.db.collection("scores").updateOne({ _id: existingScore._id }, { $set: updateData });
    await recordScoreChange(req.db, { action: 'transfer_account', before: existingScore, after: updateData, user: req.user });

    // The base score changed account: recompute the following differentials of the target account (as
    // on creation) AND those still following the previous account.
    let recalculatedCount = 0;
    if (currentRotationIndex % 2 === 0) {
      const affectedTarget = await recalculateAffectedDifferentials(req.db, cycle, currentRotationIndex, existingScore.cycle_id, target_bbs_id);
      const affectedSource = await recalculateAffectedDifferentials(req.db, cycle, currentRotationIndex, existingScore.cycle_id, existingScore.bbs_id);
      recalculatedCount = affectedTarget.length + affectedSource.length;
    }

    res.json({
      success: true,
      message: "Score transféré avec succès" + (recalculatedCount > 0 ? ` et ${recalculatedCount} scores différentiels recalculés` : ""),
      details: { rawScore: calculatedRawScore, isDifferential, recalculatedCount }
    });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors du transfert de score', "Erreur lors du transfert de score:");
  }
});

export default router;
