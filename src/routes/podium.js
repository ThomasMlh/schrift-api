import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb } from '../middleware/auth.js';

const router = express.Router();

// Middleware pour toutes les routes podium
router.use(requireDb);

// GET podium des joueurs par cycle
router.get('/', async (req, res) => {
  try {
    const { cycle_id, guild_id } = req.query;

    // Validation du cycle_id obligatoire
    if (!cycle_id) {
      return res.status(400).json({
        success: false,
        message: 'Le paramètre cycle_id est obligatoire'
      });
    }

    // Construction du pipeline d'agrégation
    const matchStage = {
      cycle_id: cycle_id
    };

    // Ajouter le filtre guilde si spécifié
    if (guild_id) {
      matchStage.guild_id = guild_id;
    }

    const pipeline = [
      // Étape 1: Filtrer les scores par cycle (et guilde si spécifiée)
      {
        $match: matchStage
      },
      // Étape 2: Grouper par user_id pour calculer la moyenne des scores
      {
        $group: {
          _id: "$user_id",
          averageScore: { $avg: "$score" },
          totalScores: { $sum: 1 }
        }
      }
    ];

    // Continuer avec la jointure
    const pipelineWithJoin = [
      ...pipeline,
      // Étape 3: Joindre avec la collection users
      {
        $lookup: {
          from: 'users',
          let: { userId: "$_id" },
          pipeline: [
            { 
              $match: { 
                $expr: { 
                  $or: [
                    { $eq: [{ $toString: "$_id" }, "$$userId"] }
                  ]
                }
              }
            },
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
          as: 'user'
        }
      },
      // Étape 4: Joindre avec la collection guildes
      {
        $lookup: {
          from: 'guildes',
          let: { guildeId: { $arrayElemAt: ["$user.guilde_id", 0] } },
          pipeline: [
            { 
              $match: { 
                $expr: { 
                  $eq: [{ $toString: "$_id" }, "$$guildeId"]
                }
              }
            },
            { $project: { name: 1 } }
          ],
          as: 'guild'
        }
      },
      // Étape 5: Ajouter info sur la présence d'utilisateur
      {
        $addFields: {
          hasUser: { $gt: [{ $size: "$user" }, 0] }
        }
      },
      // Étape 6: Projeter les champs finaux
      {
        $project: {
          _id: 0,
          user_id: "$_id",
          bbs_name: { $arrayElemAt: ["$user.bbs_name", 0] },
          discord_id: { $arrayElemAt: ["$user.discord_id", 0] },
          global_name: { $arrayElemAt: ["$user.global_name", 0] },
          averageScore: { $round: ["$averageScore", 0] },
          avatar: { $arrayElemAt: ["$user.avatar", 0] },
          guild_name: { $arrayElemAt: ["$guild.name", 0] },
          totalScores: 1,
          hasUser: 1
        }
      },
      // Étape 7: Trier par moyenne décroissante
      {
        $sort: { averageScore: -1 }
      },
      // Étape 8: Limiter aux premiers résultats
      {
        $limit: guild_id ? 5 : 10
      }
    ];

    const podium = await req.db.collection('scores')
      .aggregate(pipelineWithJoin)
      .toArray();

    // Ajouter les positions dans le podium
    const podiumWithRank = podium.map((player, index) => ({
      rank: index + 1,
      ...player
    }));

    res.json({
      success: true,
      podium: podiumWithRank,
      filters: {
        cycle_id: cycle_id,
        guild_id: guild_id || null
      },
      meta: {
        totalPlayers: podium.length,
        cycleId: cycle_id,
        guildSpecific: !!guild_id
      }
    });

  } catch (error) {
    console.error('Erreur lors de la création du podium:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erreur serveur lors de la création du podium'
    });
  }
});

// GET podium complet des joueurs par cycle_name et rotation_id
router.get('/full', async (req, res) => {
  try {
    const {
      cycle_name,
      rotation_id,
      guild_name,
      ranking_type = 'average',
      page = 1,
      limit = 50,
    } = req.query;

    // Validation des paramètres obligatoires
    if (!cycle_name) {
      return res.status(400).json({
        success: false,
        message: 'Le paramètre cycle_name est obligatoire'
      });
    }
    
    // Validation et conversion des paramètres de pagination
    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const limitNumber = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNumber - 1) * limitNumber;

    const normalizedRankingType = String(ranking_type).toLowerCase();
    if (!rotation_id && !['average', 'max'].includes(normalizedRankingType)) {
      return res.status(400).json({
        success: false,
        message: 'ranking_type doit être "average" ou "max"'
      });
    }

    // Rechercher le cycle par son nom
    const cycle = await req.db.collection('cycles').findOne({
      name: cycle_name
    });

    if (!cycle) {
      return res.status(404).json({
        success: false,
        message: `Cycle avec le nom "${cycle_name}" non trouvé`
      });
    }

    // Vérifier que la rotation_id existe (si spécifiée)
    let rotationDoc = null;
    if (rotation_id) {
      try {
        rotationDoc = await req.db.collection('rotations').findOne({
          _id: new ObjectId(rotation_id)
        });

        if (!rotationDoc) {
          return res.status(404).json({
            success: false,
            message: `Rotation avec l'ID "${rotation_id}" non trouvée`
          });
        }
      } catch (error) {
        return res.status(400).json({
          success: false,
          message: `Format d'ID de rotation invalide: "${rotation_id}"`
        });
      }
    }

    // Si guild_name est spécifié, rechercher la guilde correspondante
    let guildId = null;
    if (guild_name && guild_name.trim()) {
      const guild = await req.db.collection('guildes').findOne({
        name: guild_name.trim()
      });

      if (!guild) {
        return res.status(404).json({
          success: false,
          message: `Guilde avec le nom "${guild_name}" non trouvée`
        });
      }

      guildId = guild._id.toString();
    }

    // Construction du pipeline d'agrégation
    const matchStage = {
      cycle_id: cycle._id.toString()
    };

    // Ajouter le filtre rotation si spécifié
    if (rotation_id) {
      matchStage.rotation_id = rotation_id;
    }

    // Ajouter le filtre guilde si spécifié
    if (guildId) {
      matchStage.guild_id = guildId;
    }

    let pipelineForRanking;
    
    if (rotation_id) {
      // Pipeline pour une rotation spécifique (scores individuels)
      pipelineForRanking = [
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
                      { $eq: [{ $toString: "$_id" }, "$$userId"] },
                      { $eq: ["$discord_id", "$$userId"] }
                    ]
                  }
                }
              },
              {
                $project: {
                  discord_id: 1,
                  global_name: 1,
                  bbs_name: 1,
                  avatar: 1,
                  guilde_id: 1
                }
              }
            ],
            as: 'user'
          }
        },
        {
          $lookup: {
            from: 'guildes',
            let: { guildeId: { $arrayElemAt: ["$user.guilde_id", 0] } },
            pipeline: [
              { 
                $match: { 
                  $expr: { 
                    $eq: [{ $toString: "$_id" }, "$$guildeId"]
                  }
                }
              },
              { $project: { name: 1 } }
            ],
            as: 'guild'
          }
        },
        {
          $addFields: {
            hasUser: { $gt: [{ $size: "$user" }, 0] }
          }
        },
        {
          $project: {
            _id: 0,
            user_id: "$user_id",
            bbs_name: { $arrayElemAt: ["$user.bbs_name", 0] },
            discord_id: { $arrayElemAt: ["$user.discord_id", 0] },
            global_name: { $arrayElemAt: ["$user.global_name", 0] },
            score: "$score",
            raw_score: "$raw_score",
            is_differential: "$is_differential",
            avatar: { $arrayElemAt: ["$user.avatar", 0] },
            guild_name: { $arrayElemAt: ["$guild.name", 0] },
            hasUser: 1
          }
        },
        { $sort: { score: -1 } }
      ];
    } else {
      // Pipeline pour tout le cycle (moyennes / total) par joueur
      pipelineForRanking = [
        { $match: matchStage },
        {
          $group: {
            _id: "$user_id",
            averageScore: { $avg: "$score" },
            totalScore: { $sum: "$score" },
            totalScores: { $sum: 1 },
            totalRawScore: { $sum: "$raw_score" }
          }
        },
        {
          $lookup: {
            from: 'users',
            let: { userId: "$_id" },
            pipeline: [
              { 
                $match: { 
                  $expr: { 
                    $or: [
                      { $eq: [{ $toString: "$_id" }, "$$userId"] },
                      { $eq: ["$discord_id", "$$userId"] }
                    ]
                  }
                }
              },
              {
                $project: {
                  discord_id: 1,
                  global_name: 1,
                  bbs_name: 1,
                  avatar: 1,
                  guilde_id: 1
                }
              }
            ],
            as: 'user'
          }
        },
        {
          $lookup: {
            from: 'guildes',
            let: { guildeId: { $arrayElemAt: ["$user.guilde_id", 0] } },
            pipeline: [
              { 
                $match: { 
                  $expr: { 
                    $eq: [{ $toString: "$_id" }, "$$guildeId"]
                  }
                }
              },
              { $project: { name: 1 } }
            ],
            as: 'guild'
          }
        },
        {
          $addFields: {
            hasUser: { $gt: [{ $size: "$user" }, 0] }
          }
        },
        {
          $project: {
            _id: 0,
            user_id: "$_id",
            bbs_name: { $arrayElemAt: ["$user.bbs_name", 0] },
            discord_id: { $arrayElemAt: ["$user.discord_id", 0] },
            global_name: { $arrayElemAt: ["$user.global_name", 0] },
            averageScore: { $round: ["$averageScore", 0] },
            totalScore: { $round: ["$totalScore", 0] },
            totalScores: 1,
            totalRawScore: 1,
            avatar: { $arrayElemAt: ["$user.avatar", 0] },
            guild_name: { $arrayElemAt: ["$guild.name", 0] },
            hasUser: 1
          }
        },
        {
          $sort: {
            [normalizedRankingType === 'max' ? 'totalScore' : 'averageScore']:
              -1,
          },
        }
      ];
    }

    // Exécuter le pipeline complet
    const allResults = await req.db.collection('scores').aggregate(pipelineForRanking).toArray();

    const rankingSource = allResults;
    
    // Calculer les ranks
    let currentRank = 1;
    let previousScore = null;

    const resultsWithRank = rankingSource.map((player, index) => {
      const scoreToCompare = rotation_id
        ? player.score
        : normalizedRankingType === 'max'
        ? player.totalScore
        : player.averageScore;
      
      if (index > 0 && previousScore !== null && scoreToCompare !== previousScore) {
        currentRank++;
      }
      
      previousScore = scoreToCompare;
      
      return {
        rank: currentRank,
        ...player
      };
    });

    // Appliquer la pagination
    const totalCount = resultsWithRank.length;
    const startIndex = skip;
    const endIndex = skip + limitNumber;
    const podiumWithRank = resultsWithRank.slice(startIndex, endIndex);

    const totalPages = Math.ceil(totalCount / limitNumber);

    // Récupérer les informations de la rotation
    let rotationInfo = null;
    if (rotationDoc) {
      const cycleRotationMeta = cycle.rotations.find(r => r.rotation_id === rotation_id);
      
      rotationInfo = {
        ...rotationDoc,
        ...(cycleRotationMeta && {
          start_date: cycleRotationMeta.start_date,
          end_date: cycleRotationMeta.end_date,
          period: cycleRotationMeta.period,
          position: cycleRotationMeta.position,
          _id: cycleRotationMeta._id
        })
      };
    }

    // Calculer la moyenne générale
    let overallAverageScore = null;
    if (rotation_id && rankingSource.length > 0) {
      const totalScore = rankingSource.reduce((sum, player) => sum + (player.score || 0), 0);
      overallAverageScore = Math.round(totalScore / rankingSource.length);
    }

    res.json({
      success: true,
      data: podiumWithRank,
      pagination: {
        currentPage: pageNumber,
        totalPages,
        totalCount,
        hasNextPage: pageNumber < totalPages,
        hasPrevPage: pageNumber > 1,
        itemsPerPage: limitNumber,
        itemsOnPage: podiumWithRank.length
      },
      filters: {
        cycle_name: cycle_name,
        cycle_id: cycle._id.toString(),
        rotation_id: rotation_id || null,
        guild_name: guild_name || null,
        ranking_type: rotation_id ? null : normalizedRankingType
      },
      meta: {
        totalPlayers: totalCount,
        cycleName: cycle_name,
        rotationInfo: rotationInfo,
        guildSpecific: !!guild_name,
        fullPodium: true,
        podiumType: rotation_id
          ? 'individual_scores'
          : normalizedRankingType === 'max'
          ? 'max_scores'
          : 'average_scores',
        ...(rotation_id && overallAverageScore !== null && { averageScore: overallAverageScore })
      }
    });

  } catch (error) {
    console.error('Erreur lors de la création du podium complet:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erreur serveur lors de la création du podium complet'
    });
  }
});

// GET podium des joueurs par semaine (2 rotations consécutives)
router.get('/weekly', async (req, res) => {
  try {
    const { cycle_name, week_number, guild_name, page = 1, limit = 50 } = req.query;

    // Validation des paramètres obligatoires
    if (!cycle_name) {
      return res.status(400).json({
        success: false,
        message: 'Le paramètre cycle_name est obligatoire'
      });
    }

    if (!week_number) {
      return res.status(400).json({
        success: false,
        message: 'Le paramètre week_number est obligatoire'
      });
    }

    const weekNum = parseInt(week_number, 10);
    if (isNaN(weekNum) || weekNum < 1) {
      return res.status(400).json({
        success: false,
        message: 'week_number doit être un nombre entier positif'
      });
    }

    // Validation et conversion des paramètres de pagination
    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const limitNumber = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNumber - 1) * limitNumber;

    // Rechercher le cycle par son nom
    const cycle = await req.db.collection('cycles').findOne({
      name: cycle_name
    });

    if (!cycle) {
      return res.status(404).json({
        success: false,
        message: `Cycle avec le nom "${cycle_name}" non trouvé`
      });
    }

    // Vérifier que le cycle a un nombre pair de rotations
    if (!cycle.rotations || cycle.rotations.length % 2 !== 0) {
      return res.status(400).json({
        success: false,
        message: 'Le cycle doit avoir un nombre pair de rotations pour calculer les semaines'
      });
    }

    // Calculer les positions des rotations pour cette semaine
    const rotation1Position = (weekNum * 2) - 1;
    const rotation2Position = weekNum * 2;

    // Vérifier que les positions existent
    if (rotation1Position > cycle.rotations.length || rotation2Position > cycle.rotations.length) {
      return res.status(404).json({
        success: false,
        message: `Semaine ${weekNum} invalide. Le cycle n'a que ${Math.floor(cycle.rotations.length / 2)} semaines`
      });
    }

    // Récupérer les informations des 2 rotations de la semaine
    const rotation1Meta = cycle.rotations.find(r => r.position === rotation1Position);
    const rotation2Meta = cycle.rotations.find(r => r.position === rotation2Position);

    if (!rotation1Meta || !rotation2Meta) {
      return res.status(500).json({
        success: false,
        message: 'Erreur lors de la récupération des rotations de la semaine'
      });
    }

    const rotation1Id = rotation1Meta.rotation_id;
    const rotation2Id = rotation2Meta.rotation_id;

    // Récupérer les détails des rotations
    const [rotation1Doc, rotation2Doc] = await Promise.all([
      req.db.collection('rotations').findOne({ _id: new ObjectId(rotation1Id) }),
      req.db.collection('rotations').findOne({ _id: new ObjectId(rotation2Id) })
    ]);

    // Si guild_name est spécifié, rechercher la guilde
    let guildId = null;
    if (guild_name && guild_name.trim()) {
      const guild = await req.db.collection('guildes').findOne({
        name: guild_name.trim()
      });

      if (!guild) {
        return res.status(404).json({
          success: false,
          message: `Guilde avec le nom "${guild_name}" non trouvée`
        });
      }

      guildId = guild._id.toString();
    }

    // Construction du pipeline d'agrégation
    const matchStage = {
      cycle_id: cycle._id.toString(),
      rotation_id: { $in: [rotation1Id, rotation2Id] }
    };

    if (guildId) {
      matchStage.guild_id = guildId;
    }

    // Pipeline d'agrégation pour calculer les scores de la semaine
    const pipeline = [
      { $match: matchStage },
      {
        $group: {
          _id: {
            user_id: "$user_id",
            rotation_id: "$rotation_id"
          },
          score: { $first: "$score" }
        }
      },
      {
        $group: {
          _id: "$_id.user_id",
          rotation_scores: {
            $push: {
              rotation_id: "$_id.rotation_id",
              score: "$score"
            }
          }
        }
      },
      {
        $addFields: {
          week_total_score: { $sum: "$rotation_scores.score" },
          rotation1_score: {
            $let: {
              vars: {
                rot1: {
                  $arrayElemAt: [
                    {
                      $filter: {
                        input: "$rotation_scores",
                        as: "rs",
                        cond: { $eq: ["$$rs.rotation_id", rotation1Id] }
                      }
                    },
                    0
                  ]
                }
              },
              in: { $ifNull: ["$$rot1.score", 0] }
            }
          },
          rotation2_score: {
            $let: {
              vars: {
                rot2: {
                  $arrayElemAt: [
                    {
                      $filter: {
                        input: "$rotation_scores",
                        as: "rs",
                        cond: { $eq: ["$$rs.rotation_id", rotation2Id] }
                      }
                    },
                    0
                  ]
                }
              },
              in: { $ifNull: ["$$rot2.score", 0] }
            }
          }
        }
      },
      {
        $lookup: {
          from: 'users',
          let: { userId: "$_id" },
          pipeline: [
            { 
              $match: { 
                $expr: { 
                  $or: [
                    { $eq: [{ $toString: "$_id" }, "$$userId"] },
                    { $eq: ["$discord_id", "$$userId"] }
                  ]
                }
              }
            },
            {
              $project: {
                discord_id: 1,
                global_name: 1,
                bbs_name: 1,
                avatar: 1,
                username: 1,
                guilde_id: 1
              }
            }
          ],
          as: 'user'
        }
      },
      {
        $lookup: {
          from: 'guildes',
          let: { guildeId: { $arrayElemAt: ["$user.guilde_id", 0] } },
          pipeline: [
            { 
              $match: { 
                $expr: { 
                  $eq: [{ $toString: "$_id" }, "$$guildeId"]
                }
              }
            },
            { $project: { name: 1 } }
          ],
          as: 'guild'
        }
      },
      {
        $addFields: {
          hasUser: { $gt: [{ $size: "$user" }, 0] }
        }
      },
      {
        $project: {
          _id: 0,
          user_id: "$_id",
          bbs_name: { $arrayElemAt: ["$user.bbs_name", 0] },
          discord_id: { $arrayElemAt: ["$user.discord_id", 0] },
          global_name: { $arrayElemAt: ["$user.global_name", 0] },
          username: { $arrayElemAt: ["$user.username", 0] },
          avatar: { $arrayElemAt: ["$user.avatar", 0] },
          guild_name: { $arrayElemAt: ["$guild.name", 0] },
          week_total_score: 1,
          rotation1_score: 1,
          rotation2_score: 1,
          hasUser: 1
        }
      },
      { $sort: { week_total_score: -1 } }
    ];

    // Exécuter le pipeline complet
    const allResults = await req.db.collection('scores').aggregate(pipeline).toArray();
    
    // Calculer les ranks
    let currentRank = 1;
    let previousScore = null;

    const resultsWithRank = allResults.map((player, index) => {
      if (index > 0 && previousScore !== null && player.week_total_score !== previousScore) {
        currentRank++;
      }
      
      previousScore = player.week_total_score;
      
      return {
        rank: currentRank,
        ...player
      };
    });

    // Appliquer la pagination
    const totalCount = resultsWithRank.length;
    const startIndex = skip;
    const endIndex = skip + limitNumber;
    const podiumWithRank = resultsWithRank.slice(startIndex, endIndex);

    const totalPages = Math.ceil(totalCount / limitNumber);

    // Calculer la moyenne des scores de la semaine
    const totalWeekScore = allResults.reduce((sum, player) => sum + (player.week_total_score || 0), 0);
    const averageWeekScore = allResults.length > 0 ? Math.round(totalWeekScore / allResults.length) : 0;

    // Préparer les informations des rotations
    const rotationsInfo = [
      {
        position: rotation1Position,
        killer: rotation1Doc?.killer || 'Unknown',
        attack: rotation1Doc?.attack || 'Unknown',
        start_date: rotation1Meta.start_date,
        end_date: rotation1Meta.end_date
      },
      {
        position: rotation2Position,
        killer: rotation2Doc?.killer || 'Unknown',
        attack: rotation2Doc?.attack || 'Unknown',
        start_date: rotation2Meta.start_date,
        end_date: rotation2Meta.end_date
      }
    ];

    res.json({
      success: true,
      data: podiumWithRank,
      pagination: {
        currentPage: pageNumber,
        totalPages,
        totalCount,
        hasNextPage: pageNumber < totalPages,
        hasPrevPage: pageNumber > 1,
        itemsPerPage: limitNumber,
        itemsOnPage: podiumWithRank.length
      },
      filters: {
        cycle_name: cycle_name,
        cycle_id: cycle._id.toString(),
        week_number: weekNum,
        guild_name: guild_name || undefined
      },
      meta: {
        weekNumber: weekNum,
        rotationsInfo: rotationsInfo,
        totalPlayers: totalCount,
        averageWeekScore: averageWeekScore
      }
    });

  } catch (error) {
    console.error('Erreur lors de la création du podium hebdomadaire:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erreur serveur lors de la création du podium hebdomadaire'
    });
  }
});

// GET podium des miss (scores négatifs ou nuls)
router.get('/misses', async (req, res) => {
  try {
    const { cycle_name, guild_name, page = 1, limit = 50 } = req.query;

    // Validation des paramètres obligatoires
    if (!cycle_name) {
      return res.status(400).json({
        success: false,
        message: 'Le paramètre cycle_name est obligatoire'
      });
    }

    // Validation et conversion des paramètres de pagination
    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const limitNumber = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNumber - 1) * limitNumber;

    // Rechercher le cycle par son nom
    const cycle = await req.db.collection('cycles').findOne({
      name: cycle_name
    });

    if (!cycle) {
      return res.status(404).json({
        success: false,
        message: `Cycle avec le nom "${cycle_name}" non trouvé`
      });
    }

    // Si guild_name est spécifié, rechercher la guilde
    let guildId = null;
    if (guild_name && guild_name.trim()) {
      const guild = await req.db.collection('guildes').findOne({
        name: guild_name.trim()
      });

      if (!guild) {
        return res.status(404).json({
          success: false,
          message: `Guilde avec le nom "${guild_name}" non trouvée`
        });
      }

      guildId = guild._id.toString();
    }

    // Construction du pipeline d'agrégation pour les miss
    const matchStage = {
      cycle_id: cycle._id.toString(),
      score: { $lte: 0 } // Filtrer les scores négatifs et les scores à 0
    };

    if (guildId) {
      matchStage.guild_id = guildId;
    }

    // Pipeline d'agrégation pour calculer les miss
    const pipeline = [
      { $match: matchStage },
      {
        $lookup: {
          from: 'rotations',
          let: { rotationId: "$rotation_id" },
          pipeline: [
            { 
              $match: { 
                $expr: { 
                  $eq: [{ $toString: "$_id" }, "$$rotationId"]
                }
              }
            }
          ],
          as: 'rotation'
        }
      },
      {
        $group: {
          _id: "$user_id",
          total_misses: { $sum: 1 },
          total_negative_score: { $sum: "$score" },
          missed_rotations: {
            $push: {
              rotation_id: "$rotation_id",
              rotation_position: {
                $let: {
                  vars: {
                    cycleRotation: {
                      $arrayElemAt: [
                        {
                          $filter: {
                            input: cycle.rotations,
                            as: "cr",
                            cond: { $eq: ["$$cr.rotation_id", "$rotation_id"] }
                          }
                        },
                        0
                      ]
                    }
                  },
                  in: "$$cycleRotation.position"
                }
              },
              score: "$score"
            }
          }
        }
      },
      {
        $lookup: {
          from: 'users',
          let: { userId: "$_id" },
          pipeline: [
            { 
              $match: { 
                $expr: { 
                  $or: [
                    { $eq: [{ $toString: "$_id" }, "$$userId"] },
                    { $eq: ["$discord_id", "$$userId"] }
                  ]
                }
              }
            },
            {
              $project: {
                discord_id: 1,
                global_name: 1,
                bbs_name: 1,
                avatar: 1,
                username: 1,
                guilde_id: 1
              }
            }
          ],
          as: 'user'
        }
      },
      {
        $lookup: {
          from: 'guildes',
          let: { guildeId: { $arrayElemAt: ["$user.guilde_id", 0] } },
          pipeline: [
            { 
              $match: { 
                $expr: { 
                  $eq: [{ $toString: "$_id" }, "$$guildeId"]
                }
              }
            },
            { $project: { name: 1 } }
          ],
          as: 'guild'
        }
      },
      {
        $addFields: {
          hasUser: { $gt: [{ $size: "$user" }, 0] }
        }
      },
      {
        $project: {
          _id: 0,
          user_id: "$_id",
          bbs_name: { $arrayElemAt: ["$user.bbs_name", 0] },
          discord_id: { $arrayElemAt: ["$user.discord_id", 0] },
          global_name: { $arrayElemAt: ["$user.global_name", 0] },
          username: { $arrayElemAt: ["$user.username", 0] },
          avatar: { $arrayElemAt: ["$user.avatar", 0] },
          guild_name: { $arrayElemAt: ["$guild.name", 0] },
          total_misses: 1,
          total_negative_score: 1,
          missed_rotations: {
            $map: {
              input: "$missed_rotations",
              as: "mr",
              in: {
                rotation_position: "$$mr.rotation_position",
                score: "$$mr.score"
              }
            }
          },
          hasUser: 1
        }
      },
      {
        $sort: { 
          total_misses: -1,
          total_negative_score: 1
        }
      }
    ];

    // Exécuter le pipeline complet
    const allResults = await req.db.collection('scores').aggregate(pipeline).toArray();
    
    // Calculer les ranks
    let currentRank = 1;
    let previousMisses = null;
    let previousNegScore = null;

    const resultsWithRank = allResults.map((player, index) => {
      if (index > 0 && previousMisses !== null && 
          (player.total_misses !== previousMisses || player.total_negative_score !== previousNegScore)) {
        currentRank++;
      }
      
      previousMisses = player.total_misses;
      previousNegScore = player.total_negative_score;
      
      return {
        rank: currentRank,
        ...player
      };
    });

    // Appliquer la pagination
    const totalCount = resultsWithRank.length;
    const startIndex = skip;
    const endIndex = skip + limitNumber;
    const podiumWithRank = resultsWithRank.slice(startIndex, endIndex);

    const totalPages = Math.ceil(totalCount / limitNumber);

    // Calculer les statistiques globales
    const totalMissesInCycle = allResults.reduce((sum, player) => sum + (player.total_misses || 0), 0);
    const averageMissesPerPlayer = allResults.length > 0 ? parseFloat((totalMissesInCycle / allResults.length).toFixed(2)) : 0;

    res.json({
      success: true,
      data: podiumWithRank,
      pagination: {
        currentPage: pageNumber,
        totalPages,
        totalCount,
        hasNextPage: pageNumber < totalPages,
        hasPrevPage: pageNumber > 1,
        itemsPerPage: limitNumber,
        itemsOnPage: podiumWithRank.length
      },
      filters: {
        cycle_name: cycle_name,
        cycle_id: cycle._id.toString(),
        guild_name: guild_name || undefined
      },
      meta: {
        totalPlayersWithMisses: totalCount,
        totalMissesInCycle: totalMissesInCycle,
        averageMissesPerPlayer: averageMissesPerPlayer
      }
    });

  } catch (error) {
    console.error('Erreur lors de la création du podium des miss:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erreur serveur lors de la création du podium des miss'
    });
  }
});

export default router;
