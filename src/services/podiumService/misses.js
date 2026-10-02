import { getCurrentGuildBbsIds, buildGuildMatch, lookupUserByUserId, overrideGuildName, paginate } from './helpers.js';

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
