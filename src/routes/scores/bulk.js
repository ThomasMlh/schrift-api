import express from "express";
import { ObjectId } from "mongodb";
import { requireScoresAccess } from "../../middleware/auth.js";
import { notifyDiscord } from "../../utils/notifyDiscord.js";
import { buildRotationIndexMap, computeDifferential, recalculateAffectedDifferentials } from "../../services/scoreDifferential.js";
import { notifyPersonalRecords } from "../../services/killerRecords.js";
import { getUserDisplayName } from "../../utils/nameMatching.js";
import { USER_DISPLAY, USER_DISPLAY_WITH_ID } from "../../utils/projections.js";
import { resolveScoreAccounts } from "../../utils/bbsAccounts.js";
import { logger } from '../../utils/logger.js';
import { sendStatusCodeError } from '../../utils/httpErrors.js';

const router = express.Router();

// POST créer plusieurs scores en lot (saisie groupée)
router.post("/bulk", requireScoresAccess, async (req, res) => {
  try {
    const scores = req.body;

    // Validation du format
    if (!Array.isArray(scores) || scores.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Un tableau de scores est requis"
      });
    }

    // Validation de chaque score et vérification des droits de guilde
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

    // Vérification des droits de guilde pour chef/sous-chef
    if (!req.user.hasFullAccess) {
      // Chef ou sous-chef : vérifier que tous les scores sont pour une guilde qu'ils gèrent
      const allowedGuildIds = req.user.allowedGuildIds || [];
      const invalidGuilds = Array.from(guildIds).filter(guildId => !allowedGuildIds.includes(guildId));

      if (invalidGuilds.length > 0) {
        return res.status(403).json({
          success: false,
          message: `Accès refusé. En tant que ${req.user.role}, vous ne pouvez saisir des scores que pour vos guildes (${allowedGuildIds.join(', ')}). Guildes non autorisées détectées : ${invalidGuilds.join(', ')}`
        });
      }
    }

    // Vérifier que chaque bbs_id appartient bien au user_id ciblé et à la bonne guilde
    const accountMap = await resolveScoreAccounts(req.db, scores);

    // Vérifier les doublons dans la requête
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

    // Identifier les scores existants et nouveaux. On cherche par {bbs_id, cycle_id, rotation_id}
    // uniquement (pas user_id) : un compte transféré à un autre user garde ses anciens scores sous
    // l'ancien user_id, filtrer aussi sur user_id manquerait le score existant et créerait un doublon.
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

    // Récupérer le cycle pour avoir l'ordre des rotations
    const cycle = await req.db.collection("cycles").findOne({
      _id: new ObjectId(scores[0].cycle_id)
    });

    if (!cycle) {
      return res.status(400).json({
        success: false,
        message: "Cycle non trouvé"
      });
    }

    // Créer un map des rotations avec leur index pour l'ordre
    const rotationIndexMap = buildRotationIndexMap(cycle);

    // SOLUTION 1: Trier les scores par index de rotation pour traitement dans le bon ordre
    const sortedScores = scores.sort((a, b) => {
      const indexA = rotationIndexMap.get(a.rotation_id) || 0;
      const indexB = rotationIndexMap.get(b.rotation_id) || 0;
      return indexA - indexB;
    });

    // Préparer les scores finaux avec calculs différentiels
    const finalScores = [];
    // Map pour stocker les scores du lot actuel par user_id et rotation_id
    const currentBatchScores = new Map();

    for (const score of sortedScores) {
      const rawScore = score.raw_score;
      const currentRotationIndex = rotationIndexMap.get(score.rotation_id);

      // D'abord chercher le score précédent dans le lot actuel, puis en DB
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

      // Stocker ce score dans le map du lot pour les calculs suivants
      const currentKey = `${score.bbs_id}-${score.rotation_id}`;
      currentBatchScores.set(currentKey, rawScore);
    }

    // Traiter les scores avec upsert (insert ou update)
    let insertedCount = 0;
    let updatedCount = 0;
    let recalculatedCount = 0;
    const processedIds = [];
    const recalculatedIds = [];
    // Scores nouvellement créés (pas les mises à jour) : seuls candidats à un record personnel,
    // pour ne pas re-fêter un record en ressaisissant un score déjà enregistré.
    const insertedScores = [];

    for (const scoreData of finalScores) {
      // bbs_id est la clé d'identité du score, pas user_id (cf. commentaire plus haut) : le filtre
      // retrouve le doc même s'il porte encore l'ancien user_id d'avant un transfert de compte, et
      // le $set ci-dessous le remet à jour vers le user_id actuel.
      const filter = {
        bbs_id: scoreData.bbs_id,
        cycle_id: scoreData.cycle_id,
        rotation_id: scoreData.rotation_id
      };

      const existingKey = `${scoreData.bbs_id}-${scoreData.cycle_id}-${scoreData.rotation_id}`;
      const isExisting = existingScores.has(existingKey);
      const currentRotationIndex = rotationIndexMap.get(scoreData.rotation_id);

      if (isExisting) {
        // Mettre à jour le score existant
        scoreData.updated_at = new Date();
        delete scoreData.created_at; // Ne pas modifier created_at lors d'une mise à jour

        const result = await req.db
          .collection("scores")
          .updateOne(filter, { $set: scoreData });

        if (result.matchedCount > 0) {
          updatedCount++;
          processedIds.push(existingScores.get(existingKey)._id);
        }
      } else {
        // Insérer un nouveau score
        const result = await req.db.collection("scores").insertOne(scoreData);
        if (result.insertedId) {
          insertedCount++;
          processedIds.push(result.insertedId);
          insertedScores.push(scoreData);
        }
      }

      // SOLUTION 2: Si c'est un score de base (index pair), recalculer les différentiels suivants
      if (currentRotationIndex % 2 === 0) {
        const affectedIds = await recalculateAffectedDifferentials(req.db, cycle, currentRotationIndex, scoreData.cycle_id, scoreData.bbs_id);
        recalculatedIds.push(...affectedIds);
        recalculatedCount += affectedIds.length;
      }
    }

    // --- Notification Discord (non bloquante) ---
    try {
      // Résoudre les pseudos des joueurs
      const userIds = [...new Set(finalScores.map(s => s.user_id))];
      const users = await req.db.collection("users").find({
        _id: { $in: userIds.map(id => new ObjectId(id)) }
      }, { projection: USER_DISPLAY_WITH_ID }).toArray();
      const userMap = new Map(users.map(u => [u._id.toString(), u]));

      // Résoudre la guilde (nom + channels Discord)
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

      // Killer et type d'attaque de la rotation
      const firstRotationId = finalScores[0]?.rotation_id;
      const rotation = cycle.rotations.find(r => r.rotation_id === firstRotationId);
      const killer = rotation?.killer || "";
      const attack = rotation?.attack || "";

      // Construire le tableau des scores triés par score décroissant
      const sortedForNotif = [...finalScores].sort((a, b) => b.score - a.score);
      const scoresForNotif = sortedForNotif.map((s, i) => {
        const user = userMap.get(s.user_id);
        const pseudo = s.bbs_name || getUserDisplayName(user, s.user_id);
        return { rank: i + 1, pseudo, score: s.score, raw_score: s.raw_score };
      });

      // Résoudre le pseudo du soumetteur
      let submittedBy = "Inconnu";
      if (req.user?._id) {
        const submitter = await req.db.collection("users").findOne(
          { _id: new ObjectId(req.user._id) },
          { projection: USER_DISPLAY }
        );
        submittedBy = getUserDisplayName(submitter);
      }

      // Attendues avant la réponse : sur Vercel (serverless), l'exécution peut être coupée dès la
      // réponse envoyée, donc un appel non attendu n'est pas garanti d'aboutir (manqué de façon
      // intermittente — c'est ce qui expliquait les captures podium parfois jamais envoyées).
      // maxDuration=300s côté vercel.json laisse largement la marge pour la capture Playwright.
      await notifyDiscord("scores", {
        submitted_by: submittedBy,
        guild_name: guildName,
        cycle_name: cycle.name || "",
        killer,
        attack,
        scores: scoresForNotif,
        summary: `${insertedCount} créés, ${updatedCount} mis à jour, ${recalculatedCount} recalculés`
      }, guildChannelId);

      // Capture automatique du podium (image) vers le salon membres de la guilde,
      // en plus du récapitulatif texte envoyé au salon chefs ci-dessus.
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

    // Records personnels battus (message groupé par guilde ; ne lève jamais)
    await notifyPersonalRecords(req.db, insertedScores);

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
