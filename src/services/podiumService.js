import { ObjectId } from 'mongodb';

// Pipeline commun pour joindre users (identité Discord uniquement : avatar/global_name) à partir
// d'un champ user_id présent sur le document, et guildes à partir d'un champ guild_id présent sur
// le document lui-même (le guild_id/bbs_name du SCORE, jamais la guilde/le pseudo actuels du user
// — un même user peut avoir plusieurs comptes bbs classés séparément dans des guildes différentes).
// Nombre minimum de rotations jouées pour apparaître dans un classement basé sur une moyenne
// (sinon un joueur avec 1-2 scores excellents peut dominer des joueurs réguliers avec beaucoup
// plus de scores). Ne s'applique pas aux vues par rotation unique (un seul score possible) ni
// aux misses (comptage, pas une moyenne). Configurable par l'admin (app_settings/podium) ;
// 0 = désactivé. Repli si aucun réglage n'existe encore en base.
const DEFAULT_MIN_SCORES_FOR_RANKING = 0;

const getMinScoresForRanking = async (db) => {
  const settings = await db.collection('app_settings').findOne({ _id: 'podium' });
  return typeof settings?.min_scores_for_ranking === 'number'
    ? settings.min_scores_for_ranking
    : DEFAULT_MIN_SCORES_FOR_RANKING;
};

const lookupUserAndGuild = () => {
  return [
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
          { $project: { _id: 1, discord_id: 1, avatar: 1, global_name: 1, username: 1 } }
        ],
        as: 'user'
      }
    },
    {
      $lookup: {
        from: 'guildes',
        let: { guildId: "$guild_id" },
        pipeline: [
          { $match: { $expr: { $eq: [{ $toString: "$_id" }, "$$guildId"] } } },
          { $project: { name: 1 } }
        ],
        as: 'guild'
      }
    },
    { $addFields: { hasUser: { $gt: [{ $size: "$user" }, 0] } } }
  ];
}

// Alias conservé pour lisibilité aux call sites existants (même pipeline).
const lookupUserByUserId = lookupUserAndGuild;

// Résout les bbs_id actuellement rattachés à une guilde (users.bbs_accounts[].guilde_id),
// pour attribuer un score à la guilde ACTUELLE du compte plutôt qu'à la guilde figée sur
// le score au moment de la saisie (utile après un transfert de guilde en cours de cycle).
const getCurrentGuildBbsIds = async (db, guildId) => {
  const users = await db.collection('users').find(
    { 'bbs_accounts.guilde_id': guildId },
    { projection: { 'bbs_accounts.bbs_id': 1, 'bbs_accounts.guilde_id': 1 } }
  ).toArray();

  const bbsIds = [];
  for (const user of users) {
    for (const account of user.bbs_accounts || []) {
      if (account.guilde_id === guildId && account.bbs_id) bbsIds.push(account.bbs_id);
    }
  }
  return bbsIds;
};

// Condition de match pour une guilde : scores des comptes actuellement dans la guilde (via
// bbs_id). Les scores sans bbs_id (anciens, en voie de suppression) ne remontent jamais.
const buildGuildMatch = (currentBbsIds) => ({ bbs_id: { $in: currentBbsIds } });

// Une fois le filtre par guilde appliqué, chaque ligne appartient par construction à cette
// guilde : on force l'affichage dessus plutôt que sur le guild_id (potentiellement obsolète,
// cf. buildGuildMatch) figé sur le score.
const overrideGuildName = (results, guildName) => {
  if (guildName) results.forEach(r => { r.guild_name = guildName; });
  return results;
};

// Calcule les ranks en tenant compte des ex-aequo
const applyRanks = (results, scoreKey) => {
  let currentRank = 1;
  let previousScore = null;
  return results.map((player, index) => {
    const score = player[scoreKey];
    if (index > 0 && previousScore !== null && score !== previousScore) currentRank++;
    previousScore = score;
    return { rank: currentRank, ...player };
  });
}

// Applique la pagination sur un tableau déjà trié
const paginate = (results, page, limit) => {
  const skip = (page - 1) * limit;
  const totalCount = results.length;
  const totalPages = Math.ceil(totalCount / limit);
  const items = results.slice(skip, skip + limit);
  return {
    items,
    pagination: {
      currentPage: page,
      totalPages,
      totalCount,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
      itemsPerPage: limit,
      itemsOnPage: items.length
    }
  };
}

// GET podium simple (top 10, sans pagination)
export const getPodium = async (db, { cycle_id, guild_id }) => {
  if (!cycle_id) {
    const err = new Error('Le paramètre cycle_id est obligatoire');
    err.statusCode = 400;
    throw err;
  }

  const minScores = await getMinScoresForRanking(db);
  let currentGuildName = null;
  const matchStage = { cycle_id, bbs_id: { $ne: null } };
  if (guild_id) {
    Object.assign(matchStage, buildGuildMatch(await getCurrentGuildBbsIds(db, guild_id)));
    const guildDoc = await db.collection('guildes').findOne({ _id: new ObjectId(guild_id) });
    currentGuildName = guildDoc?.name || null;
  }

  const pipeline = [
    { $match: matchStage },
    {
      $group: {
        _id: "$bbs_id",
        user_id: { $first: "$user_id" },
        bbs_name: { $first: "$bbs_name" },
        guild_id: { $first: "$guild_id" },
        averageScore: { $avg: "$score" },
        totalScores: { $sum: 1 }
      }
    },
    { $match: { totalScores: { $gte: minScores } } },
    ...lookupUserAndGuild(),
    {
      $project: {
        _id: 0,
        bbs_id: "$_id",
        user_id: 1,
        bbs_name: 1,
        discord_id: { $arrayElemAt: ["$user.discord_id", 0] },
        global_name: { $arrayElemAt: ["$user.global_name", 0] },
        averageScore: { $round: ["$averageScore", 0] },
        avatar: { $arrayElemAt: ["$user.avatar", 0] },
        guild_name: { $arrayElemAt: ["$guild.name", 0] },
        totalScores: 1,
        hasUser: 1
      }
    },
    { $sort: { averageScore: -1 } },
    { $limit: guild_id ? 5 : 10 }
  ];

  const podium = await db.collection('scores').aggregate(pipeline).toArray();
  overrideGuildName(podium, currentGuildName);
  const podiumWithRank = podium.map((player, index) => ({ rank: index + 1, ...player }));

  return {
    podium: podiumWithRank,
    filters: { cycle_id, guild_id: guild_id || null },
    meta: {
      totalPlayers: podium.length, cycleId: cycle_id, guildSpecific: !!guild_id,
      ...(minScores > 0 && { minScoresRequired: minScores }),
    }
  };
}

// GET podium complet paginé (par cycle_name, optionnel rotation_id)
export const getPodiumFull = async (db, { cycle_name, year, rotation_id, guild_name, ranking_type = 'average', page = 1, limit = 50 }) => {
  if (!cycle_name) {
    const err = new Error('Le paramètre cycle_name est obligatoire');
    err.statusCode = 400;
    throw err;
  }

  const pageNumber = Math.max(1, parseInt(page, 10) || 1);
  const limitNumber = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
  const normalizedRankingType = String(ranking_type).toLowerCase();
  const minScores = await getMinScoresForRanking(db);

  if (!rotation_id && !['average', 'max'].includes(normalizedRankingType)) {
    const err = new Error('ranking_type doit être "average" ou "max"');
    err.statusCode = 400;
    throw err;
  }

  // Le nom d'un cycle peut être réutilisé d'une année à l'autre (l'année les distingue) :
  // on filtre par year quand il est fourni, et on trie par created_at desc en repli pour
  // résoudre vers le plus récent si year est absent ou si un doublon name+year existe.
  const cycleQuery = { name: cycle_name };
  if (year) cycleQuery.year = parseInt(year, 10);
  const cycle = await db.collection('cycles').findOne(cycleQuery, { sort: { created_at: -1 } });
  if (!cycle) {
    const err = new Error(`Cycle avec le nom "${cycle_name}" non trouvé`);
    err.statusCode = 404;
    throw err;
  }

  let rotationDoc = null;
  if (rotation_id) {
    try {
      rotationDoc = await db.collection('rotations').findOne({ _id: new ObjectId(rotation_id) });
    } catch {
      const err = new Error(`Format d'ID de rotation invalide: "${rotation_id}"`);
      err.statusCode = 400;
      throw err;
    }
    if (!rotationDoc) {
      const err = new Error(`Rotation avec l'ID "${rotation_id}" non trouvée`);
      err.statusCode = 404;
      throw err;
    }
  }

  let guildId = null;
  let currentGuildName = null;
  if (guild_name?.trim()) {
    const guild = await db.collection('guildes').findOne({ name: guild_name.trim() });
    if (!guild) {
      const err = new Error(`Guilde avec le nom "${guild_name}" non trouvée`);
      err.statusCode = 404;
      throw err;
    }
    guildId = guild._id.toString();
    currentGuildName = guild.name;
  }

  const matchStage = { cycle_id: cycle._id.toString(), bbs_id: { $ne: null } };
  if (rotation_id) matchStage.rotation_id = rotation_id;
  if (guildId) Object.assign(matchStage, buildGuildMatch(await getCurrentGuildBbsIds(db, guildId)));

  let pipeline;
  if (rotation_id) {
    // Un score par bbs_id sur une rotation donnée : pas de $group nécessaire, mais bbs_name/
    // bbs_id doivent venir du score lui-même (le compte qui a joué), pas du user courant.
    pipeline = [
      { $match: matchStage },
      ...lookupUserAndGuild(),
      {
        $project: {
          _id: 0,
          user_id: "$user_id",
          bbs_id: "$bbs_id",
          bbs_name: "$bbs_name",
          discord_id: { $arrayElemAt: ["$user.discord_id", 0] },
          global_name: { $arrayElemAt: ["$user.global_name", 0] },
          score: 1,
          raw_score: 1,
          is_differential: 1,
          avatar: { $arrayElemAt: ["$user.avatar", 0] },
          guild_name: { $arrayElemAt: ["$guild.name", 0] },
          hasUser: 1
        }
      },
      { $sort: { score: -1 } }
    ];
  } else {
    pipeline = [
      { $match: matchStage },
      {
        $group: {
          _id: "$bbs_id",
          user_id: { $first: "$user_id" },
          bbs_name: { $first: "$bbs_name" },
          guild_id: { $first: "$guild_id" },
          averageScore: { $avg: "$score" },
          totalScore: { $sum: "$score" },
          totalScores: { $sum: 1 },
          totalRawScore: { $sum: "$raw_score" }
        }
      },
      // Le seuil ne s'applique qu'au classement par moyenne : en "max" (somme), un joueur
      // avec peu de scores n'a de toute façon qu'un total plus bas, pas d'avantage injustifié.
      ...(normalizedRankingType === 'max' ? [] : [{ $match: { totalScores: { $gte: minScores } } }]),
      ...lookupUserAndGuild(),
      {
        $project: {
          _id: 0,
          bbs_id: "$_id",
          user_id: 1,
          bbs_name: 1,
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
      { $sort: { [normalizedRankingType === 'max' ? 'totalScore' : 'averageScore']: -1 } }
    ];
  }

  const allResults = await db.collection('scores').aggregate(pipeline).toArray();
  overrideGuildName(allResults, currentGuildName);
  const scoreKey = rotation_id ? 'score' : (normalizedRankingType === 'max' ? 'totalScore' : 'averageScore');
  const resultsWithRank = applyRanks(allResults, scoreKey);
  const { items: data, pagination } = paginate(resultsWithRank, pageNumber, limitNumber);

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

  const overallAverageScore = (rotation_id && allResults.length > 0)
    ? Math.round(allResults.reduce((sum, p) => sum + (p.score || 0), 0) / allResults.length)
    : null;

  return {
    data,
    pagination,
    filters: {
      cycle_name,
      cycle_id: cycle._id.toString(),
      rotation_id: rotation_id || null,
      guild_name: guild_name || null,
      ranking_type: rotation_id ? null : normalizedRankingType
    },
    meta: {
      totalPlayers: pagination.totalCount,
      cycleName: cycle_name,
      rotationInfo,
      guildSpecific: !!guild_name,
      fullPodium: true,
      podiumType: rotation_id ? 'individual_scores' : (normalizedRankingType === 'max' ? 'max_scores' : 'average_scores'),
      ...(rotation_id && overallAverageScore !== null && { averageScore: overallAverageScore }),
      ...(!rotation_id && normalizedRankingType !== 'max' && minScores > 0 && { minScoresRequired: minScores })
    }
  };
}

// GET podium hebdomadaire (2 rotations consécutives)
export const getPodiumWeekly = async (db, { cycle_name, year, week_number, guild_name, page = 1, limit = 50 }) => {
  if (!cycle_name) {
    const err = new Error('Le paramètre cycle_name est obligatoire');
    err.statusCode = 400;
    throw err;
  }
  if (!week_number) {
    const err = new Error('Le paramètre week_number est obligatoire');
    err.statusCode = 400;
    throw err;
  }

  const weekNum = parseInt(week_number, 10);
  if (isNaN(weekNum) || weekNum < 1) {
    const err = new Error('week_number doit être un nombre entier positif');
    err.statusCode = 400;
    throw err;
  }

  const pageNumber = Math.max(1, parseInt(page, 10) || 1);
  const limitNumber = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

  // Le nom d'un cycle peut être réutilisé d'une année à l'autre (l'année les distingue) :
  // on filtre par year quand il est fourni, et on trie par created_at desc en repli pour
  // résoudre vers le plus récent si year est absent ou si un doublon name+year existe.
  const cycleQuery = { name: cycle_name };
  if (year) cycleQuery.year = parseInt(year, 10);
  const cycle = await db.collection('cycles').findOne(cycleQuery, { sort: { created_at: -1 } });
  if (!cycle) {
    const err = new Error(`Cycle avec le nom "${cycle_name}" non trouvé`);
    err.statusCode = 404;
    throw err;
  }

  if (!cycle.rotations || cycle.rotations.length % 2 !== 0) {
    const err = new Error('Le cycle doit avoir un nombre pair de rotations pour calculer les semaines');
    err.statusCode = 400;
    throw err;
  }

  const rotation1Position = (weekNum * 2) - 1;
  const rotation2Position = weekNum * 2;

  if (rotation1Position > cycle.rotations.length || rotation2Position > cycle.rotations.length) {
    const err = new Error(`Semaine ${weekNum} invalide. Le cycle n'a que ${Math.floor(cycle.rotations.length / 2)} semaines`);
    err.statusCode = 404;
    throw err;
  }

  const rotation1Meta = cycle.rotations.find(r => r.position === rotation1Position);
  const rotation2Meta = cycle.rotations.find(r => r.position === rotation2Position);

  if (!rotation1Meta || !rotation2Meta) {
    const err = new Error('Erreur lors de la récupération des rotations de la semaine');
    err.statusCode = 500;
    throw err;
  }

  const rotation1Id = rotation1Meta.rotation_id;
  const rotation2Id = rotation2Meta.rotation_id;

  const [rotation1Doc, rotation2Doc] = await Promise.all([
    db.collection('rotations').findOne({ _id: new ObjectId(rotation1Id) }),
    db.collection('rotations').findOne({ _id: new ObjectId(rotation2Id) })
  ]);

  let guildId = null;
  let currentGuildName = null;
  if (guild_name?.trim()) {
    const guild = await db.collection('guildes').findOne({ name: guild_name.trim() });
    if (!guild) {
      const err = new Error(`Guilde avec le nom "${guild_name}" non trouvée`);
      err.statusCode = 404;
      throw err;
    }
    guildId = guild._id.toString();
    currentGuildName = guild.name;
  }

  const matchStage = {
    cycle_id: cycle._id.toString(),
    rotation_id: { $in: [rotation1Id, rotation2Id] },
    bbs_id: { $ne: null }
  };
  if (guildId) Object.assign(matchStage, buildGuildMatch(await getCurrentGuildBbsIds(db, guildId)));

  const pipeline = [
    { $match: matchStage },
    {
      $group: {
        _id: { bbs_id: "$bbs_id", rotation_id: "$rotation_id" },
        score: { $first: "$score" },
        user_id: { $first: "$user_id" },
        bbs_name: { $first: "$bbs_name" },
        guild_id: { $first: "$guild_id" }
      }
    },
    {
      $group: {
        _id: "$_id.bbs_id",
        user_id: { $first: "$user_id" },
        bbs_name: { $first: "$bbs_name" },
        guild_id: { $first: "$guild_id" },
        rotation_scores: { $push: { rotation_id: "$_id.rotation_id", score: "$score" } }
      }
    },
    {
      $addFields: {
        week_total_score: { $sum: "$rotation_scores.score" },
        rotation1_score: {
          $let: {
            vars: { rot1: { $arrayElemAt: [{ $filter: { input: "$rotation_scores", as: "rs", cond: { $eq: ["$$rs.rotation_id", rotation1Id] } } }, 0] } },
            in: { $ifNull: ["$$rot1.score", 0] }
          }
        },
        rotation2_score: {
          $let: {
            vars: { rot2: { $arrayElemAt: [{ $filter: { input: "$rotation_scores", as: "rs", cond: { $eq: ["$$rs.rotation_id", rotation2Id] } } }, 0] } },
            in: { $ifNull: ["$$rot2.score", 0] }
          }
        }
      }
    },
    ...lookupUserByUserId(),
    {
      $project: {
        _id: 0,
        bbs_id: "$_id",
        user_id: 1,
        bbs_name: 1,
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

  const allResults = await db.collection('scores').aggregate(pipeline).toArray();
  overrideGuildName(allResults, currentGuildName);
  const resultsWithRank = applyRanks(allResults, 'week_total_score');
  const { items: data, pagination } = paginate(resultsWithRank, pageNumber, limitNumber);

  const totalWeekScore = allResults.reduce((sum, p) => sum + (p.week_total_score || 0), 0);
  const averageWeekScore = allResults.length > 0 ? Math.round(totalWeekScore / allResults.length) : 0;

  return {
    data,
    pagination,
    filters: {
      cycle_name,
      cycle_id: cycle._id.toString(),
      week_number: weekNum,
      guild_name: guild_name || undefined
    },
    meta: {
      weekNumber: weekNum,
      rotationsInfo: [
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
      ],
      totalPlayers: pagination.totalCount,
      averageWeekScore
    }
  };
}

// GET podium des miss (scores à 0 ou négatifs)
export const getPodiumMisses = async (db, { cycle_name, year, guild_name, page = 1, limit = 50 }) => {
  if (!cycle_name) {
    const err = new Error('Le paramètre cycle_name est obligatoire');
    err.statusCode = 400;
    throw err;
  }

  const pageNumber = Math.max(1, parseInt(page, 10) || 1);
  const limitNumber = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

  // Le nom d'un cycle peut être réutilisé d'une année à l'autre (l'année les distingue) :
  // on filtre par year quand il est fourni, et on trie par created_at desc en repli pour
  // résoudre vers le plus récent si year est absent ou si un doublon name+year existe.
  const cycleQuery = { name: cycle_name };
  if (year) cycleQuery.year = parseInt(year, 10);
  const cycle = await db.collection('cycles').findOne(cycleQuery, { sort: { created_at: -1 } });
  if (!cycle) {
    const err = new Error(`Cycle avec le nom "${cycle_name}" non trouvé`);
    err.statusCode = 404;
    throw err;
  }

  let guildId = null;
  let currentGuildName = null;
  if (guild_name?.trim()) {
    const guild = await db.collection('guildes').findOne({ name: guild_name.trim() });
    if (!guild) {
      const err = new Error(`Guilde avec le nom "${guild_name}" non trouvée`);
      err.statusCode = 404;
      throw err;
    }
    guildId = guild._id.toString();
    currentGuildName = guild.name;
  }

  const matchStage = { cycle_id: cycle._id.toString(), score: { $lte: 0 }, bbs_id: { $ne: null } };
  if (guildId) Object.assign(matchStage, buildGuildMatch(await getCurrentGuildBbsIds(db, guildId)));

  const pipeline = [
    { $match: matchStage },
    {
      $group: {
        _id: "$bbs_id",
        user_id: { $first: "$user_id" },
        bbs_name: { $first: "$bbs_name" },
        guild_id: { $first: "$guild_id" },
        total_misses: { $sum: 1 },
        total_negative_score: { $sum: "$score" },
        missed_rotations: {
          $push: {
            rotation_id: "$rotation_id",
            rotation_position: {
              $let: {
                vars: {
                  cycleRotation: {
                    $arrayElemAt: [{
                      $filter: {
                        input: cycle.rotations,
                        as: "cr",
                        cond: { $eq: ["$$cr.rotation_id", "$rotation_id"] }
                      }
                    }, 0]
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
    ...lookupUserByUserId(),
    {
      $project: {
        _id: 0,
        bbs_id: "$_id",
        user_id: 1,
        bbs_name: 1,
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
            in: { rotation_position: "$$mr.rotation_position", score: "$$mr.score" }
          }
        },
        hasUser: 1
      }
    },
    { $sort: { total_misses: -1, total_negative_score: 1 } }
  ];

  const allResults = await db.collection('scores').aggregate(pipeline).toArray();
  overrideGuildName(allResults, currentGuildName);

  // Rank tenant compte des ex-aequo sur les 2 critères
  let currentRank = 1;
  let prevMisses = null;
  let prevNegScore = null;
  const resultsWithRank = allResults.map((player, index) => {
    if (index > 0 && prevMisses !== null &&
        (player.total_misses !== prevMisses || player.total_negative_score !== prevNegScore)) {
      currentRank++;
    }
    prevMisses = player.total_misses;
    prevNegScore = player.total_negative_score;
    return { rank: currentRank, ...player };
  });

  const { items: data, pagination } = paginate(resultsWithRank, pageNumber, limitNumber);

  const totalMissesInCycle = allResults.reduce((sum, p) => sum + (p.total_misses || 0), 0);
  const averageMissesPerPlayer = allResults.length > 0 ? parseFloat((totalMissesInCycle / allResults.length).toFixed(2)) : 0;

  return {
    data,
    pagination,
    filters: { cycle_name, cycle_id: cycle._id.toString(), guild_name: guild_name || undefined },
    meta: { totalPlayersWithMisses: pagination.totalCount, totalMissesInCycle, averageMissesPerPlayer }
  };
}

const DEFAULT_DRAFT_GUILD_ORDER = ['A', 'C', 'B', 'E', 'D'];
const DRAFT_GUILD_SIZE = 20;

// Propose une répartition des joueurs des guildes sélectionnées sur un cycle donné : classe
// tout le monde par score (moyenne ou total) et découpe par paquets de 20 dans l'ordre de
// guildes fourni (les meilleurs vont dans la 1re guilde, les 20 suivants dans la 2e, etc.).
// Pur outil de simulation en lecture seule : ne modifie rien, l'admin applique manuellement
// via l'onglet Draft s'il valide la proposition.
export const getDraftProposal = async (db, { cycle_name, year, ranking_type = 'average', guild_names }) => {
  if (!cycle_name) {
    const err = new Error('Le paramètre cycle_name est obligatoire');
    err.statusCode = 400;
    throw err;
  }

  const normalizedRankingType = String(ranking_type).toLowerCase();
  if (!['average', 'total'].includes(normalizedRankingType)) {
    const err = new Error('ranking_type doit être "average" ou "total"');
    err.statusCode = 400;
    throw err;
  }
  const minScores = await getMinScoresForRanking(db);

  const requestedOrder = Array.isArray(guild_names)
    ? guild_names
    : String(guild_names || '').split(',').map(n => n.trim()).filter(Boolean);
  const guildOrder = requestedOrder.length > 0 ? requestedOrder : DEFAULT_DRAFT_GUILD_ORDER;

  const cycleQuery = { name: cycle_name };
  if (year) cycleQuery.year = parseInt(year, 10);
  const cycle = await db.collection('cycles').findOne(cycleQuery, { sort: { created_at: -1 } });
  if (!cycle) {
    const err = new Error(`Cycle avec le nom "${cycle_name}" non trouvé`);
    err.statusCode = 404;
    throw err;
  }

  const guildDocs = await db.collection('guildes').find({ name: { $in: guildOrder } }).toArray();
  const guildByName = new Map(guildDocs.map(g => [g.name, g]));
  const missing = guildOrder.filter(n => !guildByName.has(n));
  if (missing.length > 0) {
    const err = new Error(`Guilde(s) introuvable(s): ${missing.join(', ')}`);
    err.statusCode = 404;
    throw err;
  }

  // Pool de candidats : membres actuels des guildes concernées (via bbs_accounts, cf.
  // getCurrentGuildBbsIds), avec leur guilde actuelle pour que le front puisse repérer qui
  // bougerait par rapport à la répartition d'aujourd'hui.
  const currentGuildByBbsId = new Map();
  for (const name of guildOrder) {
    const guildId = guildByName.get(name)._id.toString();
    const bbsIds = await getCurrentGuildBbsIds(db, guildId);
    for (const bbsId of bbsIds) currentGuildByBbsId.set(bbsId, name);
  }
  const candidateBbsIds = [...currentGuildByBbsId.keys()];

  const emptyResult = {
    guilds: guildOrder.map(name => ({ guild_name: name, players: [] })),
    leftover: [],
    meta: {
      cycleName: cycle_name, rankingType: normalizedRankingType, totalCandidates: 0,
      chunkSize: DRAFT_GUILD_SIZE, guildOrder,
      ...(normalizedRankingType === 'average' && minScores > 0 && { minScoresRequired: minScores }),
    }
  };
  if (candidateBbsIds.length === 0) return emptyResult;

  const pipeline = [
    { $match: { cycle_id: cycle._id.toString(), bbs_id: { $in: candidateBbsIds } } },
    {
      $group: {
        _id: "$bbs_id",
        user_id: { $first: "$user_id" },
        bbs_name: { $first: "$bbs_name" },
        averageScore: { $avg: "$score" },
        totalScore: { $sum: "$score" },
        totalScores: { $sum: 1 },
      }
    },
    ...(normalizedRankingType === 'average' ? [{ $match: { totalScores: { $gte: minScores } } }] : []),
    ...lookupUserAndGuild(),
    {
      $project: {
        _id: 0,
        bbs_id: "$_id",
        user_id: 1,
        bbs_name: 1,
        discord_id: { $arrayElemAt: ["$user.discord_id", 0] },
        global_name: { $arrayElemAt: ["$user.global_name", 0] },
        avatar: { $arrayElemAt: ["$user.avatar", 0] },
        averageScore: { $round: ["$averageScore", 0] },
        totalScore: { $round: ["$totalScore", 0] },
        totalScores: 1,
        hasUser: 1,
      }
    },
    { $sort: { [normalizedRankingType === 'average' ? 'averageScore' : 'totalScore']: -1 } },
  ];

  const ranked = await db.collection('scores').aggregate(pipeline).toArray();
  const withCurrentGuild = ranked.map((p, i) => ({
    ...p,
    overallRank: i + 1,
    currentGuildName: currentGuildByBbsId.get(p.bbs_id) || null,
  }));

  const guilds = guildOrder.map((name, i) => ({
    guild_name: name,
    players: withCurrentGuild.slice(i * DRAFT_GUILD_SIZE, (i + 1) * DRAFT_GUILD_SIZE),
  }));
  const leftover = withCurrentGuild.slice(guildOrder.length * DRAFT_GUILD_SIZE);

  return {
    guilds,
    leftover,
    meta: {
      cycleName: cycle_name,
      rankingType: normalizedRankingType,
      totalCandidates: withCurrentGuild.length,
      chunkSize: DRAFT_GUILD_SIZE,
      guildOrder,
      ...(normalizedRankingType === 'average' && minScores > 0 && { minScoresRequired: minScores }),
    }
  };
}
