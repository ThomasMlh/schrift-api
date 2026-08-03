import express from "express";
import { ObjectId } from "mongodb";
import { requireDb, requireScoresAccess } from "../middleware/auth.js";
import { notifyDiscord } from "../utils/notifyDiscord.js";
import { compareEntities } from "../services/scoreComparison.js";
import { buildRotationIndexMap, computeDifferential, recalculateAffectedDifferentials } from "../services/scoreDifferential.js";
import { getUserDisplayName } from "../utils/nameMatching.js";
import { parsePaginationParams, buildPaginationMeta } from "../utils/pagination.js";
import { USER_DISPLAY, USER_DISPLAY_WITH_ID, USER_SCORES_LOOKUP } from "../utils/projections.js";
import { resolveScoreAccounts } from "../utils/bbsAccounts.js";
import { escapeRegex } from "../utils/regexUtils.js";

const router = express.Router();

// Middleware pour toutes les routes scores
router.use(requireDb);

// GET tous les scores avec filtres et pagination
router.get("/", async (req, res) => {
  try {
    const { page, limit, skip } = parsePaginationParams(req.query);

    // Construction des filtres
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

    // Pour la recherche par nom d'utilisateur (global_name), on doit toujours faire une agrégation
    let pipeline = [];

    if (req.query.search && req.query.search.trim()) {
      const searchTerm = escapeRegex(req.query.search.trim());

      // Pipeline d'agrégation pour joindre avec la collection users et filtrer par global_name
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
          $unwind: "$user" // Décompose le tableau user pour accéder directement aux champs
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
      // Requête simple sans recherche - mais on peut quand même joindre les données utilisateur
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

    // Pour le count, on utilise la même logique
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
          $unwind: "$user" // Décompose le tableau user pour accéder directement aux champs
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
    res.status(500).json({ error: err.message });
  }
});

// GET comparateur entre joueurs ou guildes
router.get("/compare", async (req, res) => {
  try {
    const { type, entity1, entity2, cycle_id, rotation_id } = req.query;

    // Validation des paramètres obligatoires
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

    // Validation spécifique pour les joueurs (ObjectId)
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

    // Construction des filtres selon les paramètres
    const baseFilter = {};
    
    if (cycle_id && rotation_id) {
      // Cas spécifique : cycle ET rotation spécifiés
      baseFilter.cycle_id = cycle_id;
      baseFilter.rotation_id = rotation_id;
    } else if (cycle_id) {
      // Seulement cycle spécifié
      baseFilter.cycle_id = cycle_id;
    } else if (rotation_id) {
      // Seulement rotation spécifiée - filtrage direct
      baseFilter.rotation_id = rotation_id;
    }
    // Si ni cycle_id ni rotation_id : pas de filtre temporel (tous les scores)
  
    let comparisonResults;

    if (type === "players") {
      // Comparaison entre joueurs (utilise discord_id)
      comparisonResults = await compareEntities(
        req.db,
        "user_id",
        entity1,
        entity2,
        baseFilter,
        { type: "players" }
      );
    } else {
      // Comparaison entre guildes (utilise guild_id avec le nom de la guilde)
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
    console.error("Erreur dans route compare:", err);
    res.status(500).json({ error: err.message });
  }
});


// GET un score spécifique par ID
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
    res.status(500).json({ error: err.message });
  }
});

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

        notifyDiscord("rotation_transfer", {
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
      console.error("[scores/transfer] Erreur notification Discord (non bloquant):", notifErr.message);
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
    console.error("Erreur lors du transfert de rotation:", err);
    res.status(500).json({ error: err.message });
  }
});

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

      // Résoudre la guilde (nom + channel Discord)
      const firstGuildId = finalScores[0]?.guild_id;
      let guildName = "";
      let guildChannelId = "";
      if (firstGuildId) {
        const guild = await req.db.collection("guildes").findOne({ _id: new ObjectId(firstGuildId) });
        guildName = guild?.name || "";
        guildChannelId = guild?.discord_channel_id || "";
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

      notifyDiscord("scores", {
        submitted_by: submittedBy,
        guild_name: guildName,
        cycle_name: cycle.name || "",
        killer,
        attack,
        scores: scoresForNotif,
        summary: `${insertedCount} créés, ${updatedCount} mis à jour, ${recalculatedCount} recalculés`
      }, guildChannelId);
    } catch (notifErr) {
      console.error("[scores/bulk] Erreur notification Discord (non bloquant):", notifErr.message);
    }

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
    const status = err.statusCode || 500;
    if (status === 500) console.error("Erreur lors de la saisie groupée:", err);
    res.status(status).json({ success: false, error: err.message });
  }
});

// POST créer un nouveau score
router.post("/", requireScoresAccess, async (req, res) => {
  try {
    const { user_id, cycle_id, rotation_id, guild_id, bbs_id, raw_score } = req.body;

    // Validation des champs requis
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

    // Vérifier que le raw_score est un nombre
    if (typeof raw_score !== "number") {
      return res.status(400).json({
        success: false,
        message: "Le raw_score doit être un nombre"
      });
    }

    // Vérification des droits de guilde pour chef/sous-chef
    if (!req.user.hasFullAccess && !(req.user.allowedGuildIds || []).includes(guild_id)) {
      return res.status(403).json({
        success: false,
        message: `Accès refusé. En tant que ${req.user.role}, vous ne pouvez saisir des scores que pour vos guildes.`
      });
    }

    // Vérifier que le bbs_id appartient bien au user_id ciblé et à la bonne guilde
    const accountMap = await resolveScoreAccounts(req.db, [{ user_id, bbs_id, guild_id }]);
    const account = accountMap.get(`${user_id}-${bbs_id}`);

    // Récupérer le cycle pour avoir l'ordre des rotations
    const cycle = await req.db.collection("cycles").findOne({
      _id: new ObjectId(cycle_id)
    });

    if (!cycle) {
      return res.status(400).json({
        success: false,
        message: "Cycle non trouvé"
      });
    }

    // Assurer que la rotation appartient bien au cycle
    const rotationExists = cycle.rotations.some(
      (rotation) => rotation.rotation_id === rotation_id
    );
    if (!rotationExists) {
      return res.status(400).json({
        success: false,
        message: "La rotation spécifiée n'appartient pas au cycle donné"
      });
    }

    // Créer un map des rotations avec leur index pour l'ordre
    const rotationIndexMap = buildRotationIndexMap(cycle);

    // Vérifier l'existence d'un score pour ce compte/cycle/rotation (par bbs_id : un compte
    // transféré garde ses anciens scores sous un autre user_id, filtrer dessus aussi le manquerait)
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

    // Récupérer le score précédent pour le calcul différentiel
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

    // Recalculer les scores différentiels suivants si c'est un score de base
    let recalculatedCount = 0;
    if (currentRotationIndex % 2 === 0) {
      const affectedIds = await recalculateAffectedDifferentials(req.db, cycle, currentRotationIndex, cycle_id, bbs_id);
      recalculatedCount = affectedIds.length;
    }

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
    const status = err.statusCode || 500;
    if (status === 500) console.error("Erreur lors de la création du score:", err);
    res.status(status).json({ success: false, error: err.message });
  }
});

// PUT modifier un score
router.put("/:id", requireScoresAccess, async (req, res) => {
  try {
    const { user_id, bbs_id, cycle_id, rotation_id, guild_id, score } = req.body;

    // Récupérer le score existant pour avoir les données actuelles
    const existingScore = await req.db.collection("scores").findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!existingScore) {
      return res
        .status(404)
        .json({ success: false, message: "Score non trouvé" });
    }

    // Vérification des droits de guilde pour chef/sous-chef (guilde actuelle ET cible si changée)
    if (!req.user.hasFullAccess) {
      const allowedGuildIds = req.user.allowedGuildIds || [];
      const targetGuildId = guild_id || existingScore.guild_id;
      if (!allowedGuildIds.includes(existingScore.guild_id) || !allowedGuildIds.includes(targetGuildId)) {
        return res.status(403).json({
          success: false,
          message: `Accès refusé. En tant que ${req.user.role}, vous ne pouvez modifier que des scores de vos guildes.`
        });
      }
    }

    const updateData = {
      updated_at: new Date()
    };

    if (user_id) updateData.user_id = user_id;
    if (bbs_id) updateData.bbs_id = bbs_id;
    if (cycle_id) updateData.cycle_id = cycle_id;
    if (rotation_id) updateData.rotation_id = rotation_id;
    if (guild_id) updateData.guild_id = guild_id;

    // Si le user_id ou le bbs_id changent, revérifier que le compte appartient bien au user visé
    if (user_id || bbs_id) {
      const targetUserId = user_id || existingScore.user_id;
      const targetBbsId = bbs_id || existingScore.bbs_id;
      const accountMap = await resolveScoreAccounts(req.db, [{
        user_id: targetUserId, bbs_id: targetBbsId, guild_id: guild_id || existingScore.guild_id
      }]);
      const account = accountMap.get(`${targetUserId}-${targetBbsId}`);
      if (account?.bbs_name) updateData.bbs_name = account.bbs_name;
    }

    // Si le score est modifié, recalculer le raw_score selon la logique différentielle
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
      let calculatedRawScore = score; // Par défaut, raw_score = score
      let isDifferential = false;

      // Si c'est une rotation différentielle (index impair), recalculer le raw_score
      if (currentRotationIndex > 0 && currentRotationIndex % 2 === 1) {
        const previousRotationId =
          cycle.rotations[currentRotationIndex - 1].rotation_id;

        const previousScore = await req.db.collection("scores").findOne({
          bbs_id: targetBbsId,
          cycle_id: targetCycleId,
          rotation_id: previousRotationId
        });

        if (previousScore) {
          // Recalculer raw_score = score + previousScore.raw_score
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

    // Recalculer les scores différentiels suivants si on a modifié un score de base
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

        if (currentRotationIndex % 2 === 0) { // Score de base modifié
          const affectedIds = await recalculateAffectedDifferentials(req.db, cycle, currentRotationIndex, targetCycleId, targetBbsId);
          recalculatedCount = affectedIds.length;
        }
      }
    }

    // --- Notification Discord (non bloquante) ---
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

        notifyDiscord('score_edit', {
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
        console.error('[scores/edit] Erreur notification Discord (non bloquant):', notifErr.message);
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
    const status = err.statusCode || 500;
    if (status === 500) console.error("Erreur lors de la mise à jour du score:", err);
    res.status(status).json({ success: false, error: err.message });
  }
});

// DELETE supprimer un score
router.delete("/:id", async (req, res) => {
  try {
    const result = await req.db.collection("scores").deleteOne({
      _id: new ObjectId(req.params.id)
    });

    if (result.deletedCount === 0) {
      return res
        .status(404)
        .json({ success: false, message: "Score non trouvé" });
    }

    res.json({ success: true, message: "Score supprimé avec succès" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Routes supplémentaires pour des statistiques

// GET scores par utilisateur
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
    res.status(500).json({ error: err.message });
  }
});

// GET scores par cycle
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
    res.status(500).json({ error: err.message });
  }
});

// Fonction utilitaire pour décrire la portée de la comparaison
export default router;
