import express from "express";
import { ObjectId } from "mongodb";
import { requireDb, requireScoresAccess } from "../middleware/auth.js";
import { notifyDiscord } from "../utils/notifyDiscord.js";

const router = express.Router();

// Middleware pour toutes les routes scores
router.use(requireDb);

// GET tous les scores avec filtres et pagination
router.get("/", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50; // Harmonisé avec characters
    const skip = (page - 1) * limit;

    // Limiter le nombre max par page pour éviter les abus
    const maxLimit = 200;
    const actualLimit = Math.min(limit, maxLimit);

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
      const searchTerm = req.query.search.trim();

      // Pipeline d'agrégation pour joindre avec la collection users et filtrer par global_name
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
                  discord_id: 1,
                  avatar: 1,
                  bbs_id: 1,
                  bbs_name: 1,
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
              { "user.global_name": { $regex: searchTerm, $options: "i" } },
              { "user.username": { $regex: searchTerm, $options: "i" } },
              { "user.bbs_name": { $regex: searchTerm, $options: "i" } }
            ]
          }
        },
        { $sort: { _id: -1 } },
        { $skip: skip },
        { $limit: actualLimit }
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
        { $limit: actualLimit }
      ];
    }

    const scores = await req.db
      .collection("scores")
      .aggregate(pipeline)
      .toArray();

    // Pour le count, on utilise la même logique
    let totalCount;
    if (req.query.search && req.query.search.trim()) {
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
                  $regex: req.query.search.trim(),
                  $options: "i"
                }
              },
              {
                "user.username": {
                  $regex: req.query.search.trim(),
                  $options: "i"
                }
              },
              {
                "user.bbs_name": {
                  $regex: req.query.search.trim(),
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
    const totalPages = Math.ceil(totalCount / actualLimit);

    res.json({
      success: true,
      data: scores,
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

// Fonction helper pour comparer les entités 
async function compareEntities(db, fieldName, entity1, entity2, baseFilter, options) {
  const results = {};

  for (const entityId of [entity1, entity2]) {
    // Test simple : vérifier si l'entité a des scores
    const directScoreCount = await db.collection("scores").countDocuments({ [fieldName]: entityId });
    
    if (directScoreCount === 0) {
      results[entityId] = {
        entityInfo: null,
        stats: {
          averageScore: 0,
          averageRawScore: 0,
          totalScores: 0,
          maxScore: 0,
          minScore: 0,
          maxRawScore: 0,
          minRawScore: 0
        }
      };
      continue;
    }

    // Construire le filtre avec les critères additionnels
    const filter = { ...baseFilter, [fieldName]: entityId };
    
    // Pipeline d'agrégation pour calculer les statistiques
    const pipeline = [
      { $match: filter },
      {
        $group: {
          _id: null,
          averageScore: { $avg: "$score" },
          averageRawScore: { $avg: "$raw_score" },
          totalScores: { $sum: 1 },
          maxScore: { $max: "$score" },
          minScore: { $min: "$score" },
          maxRawScore: { $max: "$raw_score" },
          minRawScore: { $min: "$raw_score" }
        }
      },
      {
        $project: {
          _id: 0,
          averageScore: { $round: ["$averageScore", 2] },
          averageRawScore: { $round: ["$averageRawScore", 2] },
          totalScores: 1,
          maxScore: 1,
          minScore: 1,
          maxRawScore: 1,
          minRawScore: 1
        }
      }
    ];

    const stats = await db.collection("scores").aggregate(pipeline).toArray();
    
    // Récupérer les informations de l'entité
    let entityInfo = null;
    try {
      if (options.type === "players") {
        entityInfo = await db.collection("users").findOne({ _id: new ObjectId(entityId) });
      } else {
        entityInfo = await db.collection("guildes").findOne({ name: entityId });
      }
    } catch (error) {
      // Si erreur de recherche, entityInfo reste null
    }

    results[entityId] = {
      entityInfo,
      stats: stats.length > 0 ? stats[0] : {
        averageScore: 0,
        averageRawScore: 0,
        totalScores: 0,
        maxScore: 0,
        minScore: 0,
        maxRawScore: 0,
        minRawScore: 0
      }
    };
  }

  // Calculer les différences
  const entity1Stats = results[entity1].stats;
  const entity2Stats = results[entity2].stats;

  const differences = {
    averageScore: {
      difference: entity1Stats.averageScore - entity2Stats.averageScore,
      percentage: entity2Stats.averageScore !== 0 
        ? ((entity1Stats.averageScore - entity2Stats.averageScore) / entity2Stats.averageScore * 100)
        : null
    },
    averageRawScore: {
      difference: entity1Stats.averageRawScore - entity2Stats.averageRawScore,
      percentage: entity2Stats.averageRawScore !== 0 
        ? ((entity1Stats.averageRawScore - entity2Stats.averageRawScore) / entity2Stats.averageRawScore * 100)
        : null
    },
    totalScores: {
      difference: entity1Stats.totalScores - entity2Stats.totalScores,
      percentage: entity2Stats.totalScores !== 0 
        ? ((entity1Stats.totalScores - entity2Stats.totalScores) / entity2Stats.totalScores * 100)
        : null
    }
  };

  // Déterminer le "gagnant" basé sur la moyenne
  let winner = null;
  if (entity1Stats.averageScore > entity2Stats.averageScore) {
    winner = entity1;
  } else if (entity2Stats.averageScore > entity1Stats.averageScore) {
    winner = entity2;
  }

  return {
    entities: results,
    differences,
    winner,
    summary: {
      entity1: { id: entity1, averageScore: entity1Stats.averageScore, totalScores: entity1Stats.totalScores },
      entity2: { id: entity2, averageScore: entity2Stats.averageScore, totalScores: entity2Stats.totalScores }
    }
  };
}

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
      const { user_id, cycle_id, rotation_id, guild_id, raw_score } = score;

      if (
        !user_id ||
        !cycle_id ||
        !rotation_id ||
        !guild_id ||
        raw_score === undefined
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Chaque score doit contenir user_id, cycle_id, rotation_id, guild_id et raw_score"
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
      // Chef ou sous-chef : vérifier que tous les scores sont pour leur guilde
      const allowedGuildId = req.user.allowedGuildId;
      const invalidGuilds = Array.from(guildIds).filter(guildId => guildId !== allowedGuildId);
      
      if (invalidGuilds.length > 0) {
        return res.status(403).json({
          success: false,
          message: `Accès refusé. En tant que ${req.user.role}, vous ne pouvez saisir des scores que pour votre guilde (${allowedGuildId}). Guildes non autorisées détectées : ${invalidGuilds.join(', ')}`
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
      const existingScore = await req.db.collection("scores").findOne({
        user_id: score.user_id,
        cycle_id: score.cycle_id,
        rotation_id: score.rotation_id
      });

      if (existingScore) {
        existingScores.set(
          `${score.user_id}-${score.cycle_id}-${score.rotation_id}`,
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
    const rotationIndexMap = new Map();
    cycle.rotations.forEach((rotation, index) => {
      rotationIndexMap.set(rotation.rotation_id, index);
    });

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
      let finalScore = rawScore;
      const currentRotationIndex = rotationIndexMap.get(score.rotation_id);
      let isDifferential = false;

      // Logique de soustraction : 1 rotation sur 2 (index impairs)
      if (currentRotationIndex > 0 && currentRotationIndex % 2 === 1) {
        // Chercher le score de la rotation précédente pour ce user
        const previousRotationId =
          cycle.rotations[currentRotationIndex - 1].rotation_id;

        // D'abord chercher dans le lot actuel
        const batchKey = `${score.user_id}-${previousRotationId}`;
        let previousRawScore = currentBatchScores.get(batchKey);

        // Si pas dans le lot, chercher en base de données
        if (previousRawScore === undefined) {
          const previousScore = await req.db.collection("scores").findOne({
            user_id: score.user_id,
            cycle_id: score.cycle_id,
            rotation_id: previousRotationId
          });

          if (previousScore) {
            previousRawScore = previousScore.raw_score;
          }
        }

        // Si on a trouvé le score précédent (lot ou DB), calculer le différentiel
        // Sinon, le score reste égal au raw_score (pas de soustraction)
        if (previousRawScore !== undefined) {
          finalScore = Math.max(0, rawScore - previousRawScore);
          isDifferential = true;
        } else {
          // Pas de score précédent trouvé, on garde le raw_score tel quel
          finalScore = rawScore;
          isDifferential = true;
        }
      }

      const scoreData = {
        user_id: score.user_id,
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
      const currentKey = `${score.user_id}-${score.rotation_id}`;
      currentBatchScores.set(currentKey, rawScore);
    }

    // SOLUTION 2: Fonction pour recalculer les scores différentiels affectés
    const recalculateAffectedDifferentials = async (cycleId, rotationIndex, userId) => {
      const recalculatedIds = [];
      
      // Chercher toutes les rotations suivantes qui sont différentielles pour ce user
      for (let i = rotationIndex + 1; i < cycle.rotations.length; i++) {
        if (i % 2 === 1) { // Rotation différentielle (index impair)
          const nextRotationId = cycle.rotations[i].rotation_id;
          
          const existingDifferentialScore = await req.db.collection("scores").findOne({
            user_id: userId,
            cycle_id: cycleId,
            rotation_id: nextRotationId
          });

          if (existingDifferentialScore) {
            // Recalculer ce score différentiel
            const previousRotationId = cycle.rotations[i - 1].rotation_id;
            const previousScore = await req.db.collection("scores").findOne({
              user_id: userId,
              cycle_id: cycleId,
              rotation_id: previousRotationId
            });

            if (previousScore) {
              const newFinalScore = Math.max(0, existingDifferentialScore.raw_score - previousScore.raw_score);
              
              await req.db.collection("scores").updateOne(
                { _id: existingDifferentialScore._id },
                { 
                  $set: { 
                    score: newFinalScore,
                    is_differential: true,
                    updated_at: new Date()
                  }
                }
              );
              
              recalculatedIds.push(existingDifferentialScore._id);
              console.log(`Score différentiel recalculé pour rotation ${i}: ${existingDifferentialScore.score} -> ${newFinalScore}`);
            }
          }
        }
      }
      
      return recalculatedIds;
    };

    // Traiter les scores avec upsert (insert ou update)
    let insertedCount = 0;
    let updatedCount = 0;
    let recalculatedCount = 0;
    const processedIds = [];
    const recalculatedIds = [];

    for (const scoreData of finalScores) {
      const filter = {
        user_id: scoreData.user_id,
        cycle_id: scoreData.cycle_id,
        rotation_id: scoreData.rotation_id
      };

      const existingKey = `${scoreData.user_id}-${scoreData.cycle_id}-${scoreData.rotation_id}`;
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
        const affectedIds = await recalculateAffectedDifferentials(
          scoreData.cycle_id, 
          currentRotationIndex, 
          scoreData.user_id
        );
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
      }, { projection: { _id: 1, global_name: 1, username: 1, bbs_name: 1 } }).toArray();
      const userMap = new Map(users.map(u => [u._id.toString(), u]));

      // Résoudre la guilde (nom + channel Discord)
      const firstGuildId = finalScores[0]?.guild_id;
      let guildName = "";
      let guildChannelId = "";
      if (firstGuildId) {
        const guild = await req.db.collection("guildes").findOne({ _id: new ObjectId(firstGuildId) });
        console.log("[scores/bulk] guild_id:", firstGuildId, "→ guild:", JSON.stringify(guild));
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
        const pseudo = user?.bbs_name || user?.global_name || user?.username || s.user_id;
        return { rank: i + 1, pseudo, score: s.score, raw_score: s.raw_score };
      });

      // Résoudre le pseudo du soumetteur
      let submittedBy = "Inconnu";
      if (req.user?._id) {
        const submitter = await req.db.collection("users").findOne(
          { _id: new ObjectId(req.user._id) },
          { projection: { global_name: 1, username: 1, bbs_name: 1 } }
        );
        submittedBy = submitter?.bbs_name || submitter?.global_name || submitter?.username || "Inconnu";
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
    console.error("Erreur lors de la saisie groupée:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST créer un nouveau score
router.post("/", async (req, res) => {
  try {
    const { user_id, cycle_id, rotation_id, guild_id, raw_score } = req.body;

    // Validation des champs requis
    if (
      !user_id ||
      !cycle_id ||
      !rotation_id ||
      !guild_id ||
      raw_score === undefined
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Les champs user_id, cycle_id, rotation_id, guild_id et raw_score sont requis"
      });
    }

    // Vérifier que le raw_score est un nombre
    if (typeof raw_score !== "number") {
      return res.status(400).json({
        success: false,
        message: "Le raw_score doit être un nombre"
      });
    }

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
    const rotationIndexMap = new Map();
    cycle.rotations.forEach((rotation, index) => {
      rotationIndexMap.set(rotation.rotation_id, index);
    });

    // Vérifier l'existence d'un score pour ce user/cycle/rotation
    const existingScore = await req.db.collection("scores").findOne({
      user_id: user_id,
      cycle_id: cycle_id,
      rotation_id: rotation_id
    });

    if (existingScore) {
      return res.status(400).json({
        success: false,
        message: `Un score existe déjà pour ce joueur dans la rotation #${
          rotationIndexMap.get(rotation_id) + 1
        } du ${cycle.name}`
      });
    }

    const currentRotationIndex = rotationIndexMap.get(rotation_id);
    let finalScore = raw_score;
    let isDifferential = false;

    // Logique de soustraction : 1 rotation sur 2 (index impairs)
    if (currentRotationIndex > 0 && currentRotationIndex % 2 === 1) {
      // Chercher le score de la rotation précédente pour ce user
      const previousRotationId =
        cycle.rotations[currentRotationIndex - 1].rotation_id;

      const previousScore = await req.db.collection("scores").findOne({
        user_id: user_id,
        cycle_id: cycle_id,
        rotation_id: previousRotationId
      });

      if (previousScore) {
        finalScore = Math.max(0, raw_score - previousScore.raw_score);
        isDifferential = true;
      } else {
        // Pas de score précédent trouvé, on garde le raw_score tel quel
        finalScore = raw_score;
        isDifferential = true;
      }
    }

    const scoreData = {
      user_id,
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
      for (let i = currentRotationIndex + 1; i < cycle.rotations.length; i++) {
        if (i % 2 === 1) { // Rotation différentielle
          const nextRotationId = cycle.rotations[i].rotation_id;
          
          const existingDifferentialScore = await req.db.collection("scores").findOne({
            user_id: user_id,
            cycle_id: cycle_id,
            rotation_id: nextRotationId
          });

          if (existingDifferentialScore) {
            const newFinalScore = Math.max(0, existingDifferentialScore.raw_score - raw_score);
            
            await req.db.collection("scores").updateOne(
              { _id: existingDifferentialScore._id },
              { 
                $set: { 
                  score: newFinalScore,
                  is_differential: true,
                  updated_at: new Date()
                }
              }
            );
            
            recalculatedCount++;
          }
        }
      }
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
    res.status(500).json({ error: err.message });
  }
});

// PUT modifier un score
router.put("/:id", requireScoresAccess, async (req, res) => {
  try {
    const { user_id, cycle_id, rotation_id, guild_id, score } = req.body;

    // Récupérer le score existant pour avoir les données actuelles
    const existingScore = await req.db.collection("scores").findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!existingScore) {
      return res
        .status(404)
        .json({ success: false, message: "Score non trouvé" });
    }

    const updateData = {
      updated_at: new Date()
    };

    if (user_id) updateData.user_id = user_id;
    if (cycle_id) updateData.cycle_id = cycle_id;
    if (rotation_id) updateData.rotation_id = rotation_id;
    if (guild_id) updateData.guild_id = guild_id;

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
      const targetUserId = user_id || existingScore.user_id;

      const cycle = await req.db.collection("cycles").findOne({
        _id: new ObjectId(targetCycleId)
      });

      if (!cycle) {
        return res.status(400).json({
          success: false,
          message: "Cycle non trouvé"
        });
      }

      const rotationIndexMap = new Map();
      cycle.rotations.forEach((rotation, index) => {
        rotationIndexMap.set(rotation.rotation_id, index);
      });

      const currentRotationIndex = rotationIndexMap.get(targetRotationId);
      let calculatedRawScore = score; // Par défaut, raw_score = score
      let isDifferential = false;

      // Si c'est une rotation différentielle (index impair), recalculer le raw_score
      if (currentRotationIndex > 0 && currentRotationIndex % 2 === 1) {
        const previousRotationId =
          cycle.rotations[currentRotationIndex - 1].rotation_id;

        const previousScore = await req.db.collection("scores").findOne({
          user_id: targetUserId,
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
      const targetUserId = user_id || existingScore.user_id;
      const targetRotationId = rotation_id || existingScore.rotation_id;
      
      const cycle = await req.db.collection("cycles").findOne({
        _id: new ObjectId(targetCycleId)
      });

      if (cycle) {
        const rotationIndexMap = new Map();
        cycle.rotations.forEach((rotation, index) => {
          rotationIndexMap.set(rotation.rotation_id, index);
        });
        
        const currentRotationIndex = rotationIndexMap.get(targetRotationId);
        
        if (currentRotationIndex % 2 === 0) { // Score de base modifié
          for (let i = currentRotationIndex + 1; i < cycle.rotations.length; i++) {
            if (i % 2 === 1) { // Rotation différentielle
              const nextRotationId = cycle.rotations[i].rotation_id;
              
              const existingDifferentialScore = await req.db.collection("scores").findOne({
                user_id: targetUserId,
                cycle_id: targetCycleId,
                rotation_id: nextRotationId
              });

              if (existingDifferentialScore) {
                const newFinalScore = Math.max(0, existingDifferentialScore.raw_score - updateData.raw_score);
                
                await req.db.collection("scores").updateOne(
                  { _id: existingDifferentialScore._id },
                  { 
                    $set: { 
                      score: newFinalScore,
                      is_differential: true,
                      updated_at: new Date()
                    }
                  }
                );
                
                recalculatedCount++;
              }
            }
          }
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
          { projection: { global_name: 1, username: 1, bbs_name: 1 } }
        );
        const pseudo = editedUser?.bbs_name || editedUser?.global_name || editedUser?.username || targetUserId;

        const guild = await req.db.collection('guildes').findOne({ _id: new ObjectId(targetGuildId) });
        const guildName = guild?.name || '';
        const guildChannelId = guild?.discord_channel_id || '';

        let submittedBy = 'Inconnu';
        if (req.user?._id) {
          const submitter = await req.db.collection('users').findOne(
            { _id: new ObjectId(req.user._id) },
            { projection: { global_name: 1, username: 1, bbs_name: 1 } }
          );
          submittedBy = submitter?.bbs_name ||submitter?.global_name || submitter?.username || 'Inconnu';
        }

        notifyDiscord('score_edit', {
          submitted_by: submittedBy,
          guild_name: guildName,
          pseudo,
          old_score: existingScore.score,
          new_score: updateData.score,
          raw_score: updateData.raw_score,
          is_differential: updateData.is_differential,
          recalculated_count: recalculatedCount
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
    res.status(500).json({ error: err.message });
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
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50; // Harmonisé avec characters
    const skip = (page - 1) * limit;

    // Limiter le nombre max par page pour éviter les abus
    const maxLimit = 200;
    const actualLimit = Math.min(limit, maxLimit);

    const scores = await req.db
      .collection("scores")
      .find({ user_id: req.params.userId })
      .sort({ _id: -1 })
      .skip(skip)
      .limit(actualLimit)
      .toArray();

    const totalCount = await req.db.collection("scores").countDocuments({
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
router.get("/cycle/:cycleId", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50; // Harmonisé avec characters
    const skip = (page - 1) * limit;

    // Limiter le nombre max par page pour éviter les abus
    const maxLimit = 200;
    const actualLimit = Math.min(limit, maxLimit);

    const scores = await req.db
      .collection("scores")
      .find({ cycle_id: req.params.cycleId })
      .sort({ _id: -1 })
      .skip(skip)
      .limit(actualLimit)
      .toArray();

    const totalCount = await req.db.collection("scores").countDocuments({
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

// Fonction utilitaire pour décrire la portée de la comparaison
function getScopeDescription(cycle_id, rotation_id) {
  if (rotation_id && cycle_id) {
    return "Rotation spécifique d'un cycle";
  } else if (cycle_id) {
    return "Cycle complet";
  } else if (rotation_id) {
    return "Rotation spécifique (tous cycles)";
  } else {
    return "Tous les scores";
  }
}

export default router;
