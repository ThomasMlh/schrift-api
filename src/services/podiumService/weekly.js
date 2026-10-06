import { ObjectId } from 'mongodb';
import { attachTopAchievements } from './achievementBadges.js';
import { getGuildScoreMatch, lookupUserByUserId, overrideGuildName, applyRanks, paginate } from './helpers.js';

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
  if (guildId) Object.assign(matchStage, await getGuildScoreMatch(db, cycle, guildId));

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
  await attachTopAchievements(db, data);

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
