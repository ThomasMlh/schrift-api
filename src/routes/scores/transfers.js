import express from "express";
import { ObjectId } from "mongodb";
import { requireScoresAccess } from "../../middleware/auth.js";
import { notifyDiscord } from "../../utils/notifyDiscord.js";
import { buildRotationIndexMap, recalculateAffectedDifferentials } from "../../services/scoreDifferential.js";
import { getUserDisplayName } from "../../utils/nameMatching.js";
import { USER_DISPLAY } from "../../utils/projections.js";
import { findAccount } from "../../utils/bbsAccounts.js";
import { logger } from '../../utils/logger.js';
import { sendServerError, sendStatusCodeError } from '../../utils/httpErrors.js';

const router = express.Router();

// POST transfert de scores d'une rotation vers une autre
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

    // Chef/Sous-chef : restreindre à une guilde qu'ils gèrent
    if (!req.user.hasFullAccess) {
      const allowedGuildIds = req.user.allowedGuildIds || [];
      if (guild_id) {
        if (!allowedGuildIds.includes(guild_id)) {
          return res.status(403).json({ success: false, message: `Accès refusé à la guilde ${guild_id}` });
        }
      } else if (allowedGuildIds.length === 1) {
        guild_id = allowedGuildIds[0];
      } else {
        return res.status(400).json({ success: false, message: "guild_id requis (vous gérez plusieurs guildes)" });
      }
    }

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

    // Filtre des scores source
    const sourceFilter = { rotation_id: source_rotation_id, cycle_id };
    if (guild_id) sourceFilter.guild_id = guild_id;

    const sourceScores = await req.db.collection("scores").find(sourceFilter).toArray();

    if (sourceScores.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Aucun score trouvé sur la rotation source avec ces critères"
      });
    }

    // Détection des conflits (scores existants sur la cible) — pour affichage uniquement, pas bloquant
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

    // Calcul du nouveau score pour chaque entrée selon l'index de la rotation cible
    const computeNewScore = async (score) => {
      if (targetIndex > 0 && targetIndex % 2 === 1) {
        const previousRotationId = cycle.rotations[targetIndex - 1].rotation_id;

        // Cas particulier : la source EST la rotation de base précédente de la cible.
        // Après transfert, cette rotation sera vide → pas de base disponible → score = raw_score.
        // (Sans ce check, on calculerait raw_score - raw_score = 0.)
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

        // Aucune base précédente utilisable → score = raw_score
        return { score: score.raw_score, isDifferential: true };
      }
      return { score: score.raw_score, isDifferential: false };
    };

    // DRY RUN : retourner l'aperçu sans rien modifier
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
        conflicts,         // Avertissements (scores qui seront écrasés)
        preview
      });
    }

    // TRANSFERT RÉEL : mise à jour en place, écrasement des conflits
    let overwrittenCount = 0;
    for (const score of sourceScores) {
      const { score: newScore, isDifferential } = await computeNewScore(score);

      // S'il existe un score sur la cible pour ce joueur, le supprimer d'abord
      const existingTarget = await req.db.collection("scores").findOne({
        bbs_id: score.bbs_id,
        cycle_id,
        rotation_id: target_rotation_id
      });
      if (existingTarget) {
        await req.db.collection("scores").deleteOne({ _id: existingTarget._id });
        overwrittenCount++;
      }

      // Mettre à jour le score source en place (change rotation_id + recalcul)
      await req.db.collection("scores").updateOne(
        { _id: score._id },
        {
          $set: {
            rotation_id: target_rotation_id,
            score: newScore,
            is_differential: isDifferential,
            updated_at: new Date()
          }
        }
      );
    }

    // Si la rotation cible est une base (index pair), recalculer les différentiels suivants
    let recalculatedCount = 0;
    if (targetIndex % 2 === 0) {
      const bbsIds = [...new Set(sourceScores.map(s => s.bbs_id))];
      for (const bbsId of bbsIds) {
        const ids = await recalculateAffectedDifferentials(req.db, cycle, targetIndex, cycle_id, bbsId);
        recalculatedCount += ids.length;
      }
    }

    // --- Notification Discord par guilde (non bloquante) ---
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

      // Grouper les scores par guilde pour envoyer une notif par guilde
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

// PUT réattribuer un score à un autre compte bbs (ex: score saisi sous le mauvais membre du
// roster faute de mieux, à corriger a posteriori). Contrairement à PUT /:id, le compte cible n'a
// PAS besoin d'appartenir ACTUELLEMENT à la guilde du score — le transfert sert justement à
// rattacher un score historique à un compte qui a depuis changé de guilde. guild_id, cycle_id et
// rotation_id ne bougent jamais ; seuls user_id/bbs_id/bbs_name changent, et raw_score est
// recalculé par rapport à l'historique du compte cible si la rotation transférée est différentielle
// (le score affiché, lui, est préservé tel quel).
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

    // Le score ne change pas de guilde pendant le transfert : les droits chef/sous-chef se
    // vérifient donc uniquement sur la guilde du score existant.
    if (!req.user.hasFullAccess) {
      const allowedGuildIds = req.user.allowedGuildIds || [];
      if (!allowedGuildIds.includes(existingScore.guild_id)) {
        return res.status(403).json({
          success: false,
          message: `Accès refusé. En tant que ${req.user.role}, vous ne pouvez modifier que des scores de vos guildes.`
        });
      }
    }

    const targetUser = await req.db.collection("users").findOne({ _id: new ObjectId(target_user_id) });
    if (!targetUser) {
      return res.status(404).json({ success: false, message: "Utilisateur cible non trouvé" });
    }
    // Pas de contrôle de guilde ici (contrairement à resolveScoreAccounts) : un transfert vise
    // justement un compte qui a pu quitter la guilde du score depuis.
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

    // Recalcule raw_score par rapport à l'historique du compte CIBLE — le score affiché
    // (existingScore.score) est préservé, seule sa provenance (raw_score) change de référentiel.
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

    // Le score de base a changé de compte : recalculer les différentiels suivants du compte
    // cible (comme à la création) ET ceux qui suivaient encore l'ancien compte.
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
