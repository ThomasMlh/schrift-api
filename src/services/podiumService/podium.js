import { ObjectId } from 'mongodb';
import {
  getMinScoresForRanking, lookupUserAndGuild, getCurrentGuildBbsIds,
  buildGuildMatch, overrideGuildName, applyRanks, paginate
} from './helpers.js';

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
