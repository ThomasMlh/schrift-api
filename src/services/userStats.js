import { ObjectId } from 'mongodb';

// Helper pour parser la date DD/MM/YYYY
const parseDate = (dateStr) => {
  if (!dateStr) return new Date(0);
  const [day, month, year] = dateStr.split('/');
  return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
}

export const getUserStats = async (db, user_id, { cycle_id } = {}) => {
  // Vérifier que l'utilisateur existe
  const user = await db.collection('users').findOne({
    $or: [
      ...(ObjectId.isValid(user_id) ? [{ _id: new ObjectId(user_id) }] : []),
      { discord_id: user_id },
      { bbs_id: user_id }
    ]
  });

  if (!user) {
    const err = new Error('Utilisateur non trouvé');
    err.statusCode = 404;
    throw err;
  }

  // Construire le filtre pour les scores
  const scoreFilter = { user_id: user._id.toString() };
  if (cycle_id) scoreFilter.cycle_id = cycle_id;

  // Récupérer tous les scores de l'utilisateur avec les détails des rotations
  const scoresWithRotations = await db.collection('scores')
    .aggregate([
      { $match: scoreFilter },
      {
        $lookup: {
          from: 'rotations',
          let: { rotationId: { $toObjectId: "$rotation_id" } },
          pipeline: [
            { $match: { $expr: { $eq: ["$_id", "$$rotationId"] } } },
            {
              $project: {
                _id: 1,
                killer: 1,
                attack: 1,
                alteration: 1,
                position: 1,
                cycle_id: 1,
                start_date: 1,
                end_date: 1
              }
            }
          ],
          as: 'rotation'
        }
      },
      { $unwind: { path: "$rotation", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          score: 1,
          cycle_id: 1,
          rotation_id: 1,
          rotation_killer: "$rotation.killer",
          rotation_attack: "$rotation.attack",
          rotation_alteration: "$rotation.alteration",
          rotation_position: "$rotation.position",
          rotation_start_date: "$rotation.start_date",
          rotation_end_date: "$rotation.end_date",
          created_at: 1
        }
      }
    ])
    .toArray();

  const userSummary = {
    _id: user._id,
    discord_id: user.discord_id,
    username: user.username,
    global_name: user.global_name,
    bbs_id: user.bbs_id,
    bbs_name: user.bbs_name,
    avatar: user.avatar,
    guilde_id: user.guilde_id,
    role: user.role
  };

  if (scoresWithRotations.length === 0) {
    return {
      user: userSummary,
      stats: {
        totalScores: 0,
        averageScore: 0,
        bestRotation: null,
        worstRotation: null,
        totalPoints: 0
      },
      filters: { cycle_id: cycle_id || null }
    };
  }

  // Statistiques globales
  const totalScores = scoresWithRotations.length;
  const totalPoints = scoresWithRotations.reduce((sum, s) => sum + (s.score || 0), 0);
  const averageScore = Math.round(totalPoints / totalScores);

  // Grouper par rotation
  const rotationStats = {};
  for (const score of scoresWithRotations) {
    if (!score.rotation_id) continue;
    if (!rotationStats[score.rotation_id]) {
      rotationStats[score.rotation_id] = {
        rotation_id: score.rotation_id,
        rotation_killer: score.rotation_killer,
        rotation_attack: score.rotation_attack,
        rotation_alteration: score.rotation_alteration,
        rotation_position: score.rotation_position,
        cycle_id: score.cycle_id,
        totalScore: 0,
        count: 0
      };
    }
    rotationStats[score.rotation_id].totalScore += score.score || 0;
    rotationStats[score.rotation_id].count += 1;
  }

  const rotationAverages = Object.values(rotationStats).map(r => ({
    ...r,
    averageScore: r.totalScore / r.count,
    scoreCount: r.count
  }));
  rotationAverages.sort((a, b) => b.averageScore - a.averageScore);

  const mapRotation = (r) => r ? {
    rotation_id: r.rotation_id,
    rotation_killer: r.rotation_killer,
    rotation_attack: r.rotation_attack,
    rotation_alteration: r.rotation_alteration,
    rotation_position: r.rotation_position,
    cycle_id: r.cycle_id,
    averageScore: Math.round(r.averageScore),
    totalScore: r.totalScore,
    scoreCount: r.scoreCount
  } : null;

  const bestRotation = mapRotation(rotationAverages[0]);
  const worstRotation = mapRotation(rotationAverages[rotationAverages.length - 1]);

  // Meilleur / pire score unique
  const bestScore = Math.max(...scoresWithRotations.map(s => s.score || 0));
  const bestScoreDetails = scoresWithRotations.find(s => s.score === bestScore);
  const worstScore = Math.min(...scoresWithRotations.map(s => s.score || 0));
  const worstScoreDetails = scoresWithRotations.find(s => s.score === worstScore);

  // Classement global
  const allUserStats = await db.collection('scores')
    .aggregate([
      ...(cycle_id ? [{ $match: { cycle_id } }] : []),
      { $group: { _id: "$user_id", averageScore: { $avg: "$score" }, totalScore: { $sum: "$score" }, count: { $sum: 1 } } },
      { $sort: { averageScore: -1 } }
    ])
    .toArray();

  const totalPlayers = allUserStats.length;
  const userRankIndex = allUserStats.findIndex(u => u._id === user._id.toString());
  const globalRank = userRankIndex !== -1 ? userRankIndex + 1 : null;

  // Classement dans la guilde
  let guildRank = null;
  let totalGuildPlayers = null;
  if (user.guilde_id) {
    const guildMembers = await db.collection('users').find({ guilde_id: user.guilde_id }).toArray();
    const guildMemberIds = guildMembers.map(m => m._id.toString());

    const guildUserStats = await db.collection('scores')
      .aggregate([
        { $match: { user_id: { $in: guildMemberIds }, ...(cycle_id ? { cycle_id } : {}) } },
        { $group: { _id: "$user_id", averageScore: { $avg: "$score" }, totalScore: { $sum: "$score" }, count: { $sum: 1 } } },
        { $sort: { averageScore: -1 } }
      ])
      .toArray();

    totalGuildPlayers = guildUserStats.length;
    const guildRankIndex = guildUserStats.findIndex(u => u._id === user._id.toString());
    if (guildRankIndex !== -1) guildRank = guildRankIndex + 1;
  }

  const percentile = totalPlayers && globalRank
    ? Math.round((1 - (globalRank - 1) / totalPlayers) * 100)
    : null;
  const top1AverageScore = allUserStats.length > 0 ? allUserStats[0].averageScore : null;
  const gapWithTop1 = top1AverageScore ? Math.round(top1AverageScore - averageScore) : null;

  // Grouper par cycle
  const cycleStats = {};
  for (const score of scoresWithRotations) {
    if (!score.cycle_id) continue;
    if (!cycleStats[score.cycle_id]) {
      cycleStats[score.cycle_id] = { cycle_id: score.cycle_id, totalScore: 0, count: 0 };
    }
    cycleStats[score.cycle_id].totalScore += score.score || 0;
    cycleStats[score.cycle_id].count += 1;
  }

  const cycleAverages = Object.values(cycleStats).map(c => ({
    cycle_id: c.cycle_id,
    averageScore: c.totalScore / c.count,
    totalScore: c.totalScore,
    scoreCount: c.count
  }));
  cycleAverages.sort((a, b) => b.averageScore - a.averageScore);

  const bestCycle = cycleAverages.length > 0 ? {
    cycle_id: cycleAverages[0].cycle_id,
    averageScore: Math.round(cycleAverages[0].averageScore),
    totalScore: cycleAverages[0].totalScore,
    scoreCount: cycleAverages[0].scoreCount
  } : null;

  if (bestCycle) {
    const cycleDoc = await db.collection('cycles').findOne({ _id: new ObjectId(bestCycle.cycle_id) });
    if (cycleDoc) bestCycle.cycle_name = cycleDoc.name;
  }

  // Ancienneté
  const firstParticipation = [...scoresWithRotations]
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0]?.created_at ?? null;

  // Builds créés
  const buildsCount = await db.collection('builds').countDocuments({ user_id: user._id.toString() });

  // Évolution temporelle
  const temporalEvolution = cycleAverages.map(c => ({
    cycle_id: c.cycle_id,
    averageScore: Math.round(c.averageScore),
    scoreCount: c.scoreCount
  }));

  if (temporalEvolution.length > 0) {
    const cycleIds = temporalEvolution.map(c => new ObjectId(c.cycle_id));
    const cycles = await db.collection('cycles').find({ _id: { $in: cycleIds } }).toArray();
    const cycleMap = {};
    cycles.forEach(c => {
      cycleMap[c._id.toString()] = {
        name: c.name,
        year: c.year,
        startDate: c.rotations?.[0]?.start_date ?? null
      };
    });
    temporalEvolution.forEach(te => {
      const info = cycleMap[te.cycle_id];
      te.cycle_name = info?.name ?? 'Inconnu';
      te.year = info?.year;
      te.start_date = info?.startDate;
    });
    temporalEvolution.sort((a, b) => parseDate(a.start_date).getTime() - parseDate(b.start_date).getTime());
  }

  // Taux de miss
  const missCount = scoresWithRotations.filter(s => s.score === 0).length;
  const missRate = totalScores > 0 ? Math.round((missCount / totalScores) * 100) : 0;

  // Tendance récente (5 dernières rotations, cycle sélectionné seulement)
  let recentTrend = null;
  if (cycle_id && scoresWithRotations.length >= 5) {
    const sortedByDate = [...scoresWithRotations].sort((a, b) => {
      const dateA = a.rotation_start_date ? parseDate(a.rotation_start_date) : new Date(a.created_at);
      const dateB = b.rotation_start_date ? parseDate(b.rotation_start_date) : new Date(b.created_at);
      return dateB.getTime() - dateA.getTime();
    });
    const last5 = sortedByDate.slice(0, 5);
    const recentAvg = last5.slice(0, 3).reduce((sum, s) => sum + s.score, 0) / 3;
    const olderAvg = last5.slice(3, 5).reduce((sum, s) => sum + s.score, 0) / 2;
    const diffPercentage = olderAvg > 0 ? Math.round(((recentAvg - olderAvg) / olderAvg) * 100) : 0;
    recentTrend = {
      direction: diffPercentage > 5 ? 'up' : diffPercentage < -5 ? 'down' : 'stable',
      percentage: Math.abs(diffPercentage),
      recentAverage: Math.round(recentAvg),
      previousAverage: Math.round(olderAvg),
      scores: last5.map(s => ({
        score: s.score,
        rotation_killer: s.rotation_killer,
        rotation_attack: s.rotation_attack,
        rotation_position: s.rotation_position,
        rotation_start_date: s.rotation_start_date
      }))
    };
  }

  // Rivaux (joueurs proches dans le classement)
  let rivals = [];
  if (globalRank && allUserStats.length > 0) {
    const userIndex = globalRank - 1;
    const startIndex = Math.max(0, userIndex - 3);
    const rivalsCandidates = allUserStats.slice(startIndex, Math.min(allUserStats.length, userIndex + 4));

    const rivalUserIds = rivalsCandidates
      .map(r => r._id)
      .filter(id => id !== user._id.toString());

    if (rivalUserIds.length > 0) {
      const rivalUsers = await db.collection('users')
        .find({ _id: { $in: rivalUserIds.map(id => new ObjectId(id)) } })
        .toArray();

      const guildIds = [...new Set(rivalUsers.map(u => u.guilde_id).filter(Boolean))];
      let guilds = [];
      if (guildIds.length > 0) {
        try {
          guilds = await db.collection('guildes')
            .find({ _id: { $in: guildIds.map(id => new ObjectId(id)) } })
            .toArray();
        } catch (err) {
          console.error('Error fetching guilds for rivals:', err.message);
        }
      }

      const guildMap = {};
      guilds.forEach(g => { guildMap[g._id.toString()] = g.name; });

      const rivalUsersMap = {};
      rivalUsers.forEach(u => { rivalUsersMap[u._id.toString()] = u; });

      rivals = rivalsCandidates
        .filter(r => r._id !== user._id.toString())
        .map(rival => {
          const rivalUser = rivalUsersMap[rival._id];
          const rivalRank = startIndex + rivalsCandidates.findIndex(c => c._id === rival._id) + 1;
          return {
            rank: rivalRank,
            user_id: rival._id,
            discord_id: rivalUser?.discord_id,
            global_name: rivalUser?.global_name,
            bbs_name: rivalUser?.bbs_name,
            avatar: rivalUser?.avatar,
            guilde_id: rivalUser?.guilde_id,
            guild_name: rivalUser?.guilde_id ? guildMap[rivalUser.guilde_id] ?? null : null,
            averageScore: Math.round(rival.averageScore),
            scoreDifference: Math.round(rival.averageScore - averageScore)
          };
        })
        .slice(0, 6);
    }
  }

  // Score médian
  const sortedScores = [...scoresWithRotations].sort((a, b) => (a.score || 0) - (b.score || 0));
  const mid = Math.floor(sortedScores.length / 2);
  const medianScore = sortedScores.length % 2 === 0
    ? Math.round((sortedScores[mid - 1].score + sortedScores[mid].score) / 2)
    : sortedScores[mid].score;

  // Écart-type et coefficient de variation (consistance)
  const variance = scoresWithRotations.reduce((sum, s) => sum + Math.pow((s.score || 0) - averageScore, 2), 0) / totalScores;
  const stdDeviation = Math.round(Math.sqrt(variance));
  const consistencyScore = averageScore > 0 ? Math.round((stdDeviation / averageScore) * 100) : 0;

  // Cycles complets (toutes 20 rotations jouées)
  const cyclesWithFullParticipation = Object.values(cycleStats).filter(c => c.count >= 20).length;

  // Contribution à la guilde (%) par cycle
  let guildContribution = null;
  if (user.guilde_id) {
    const userCycleIds = Object.keys(cycleStats);
    if (userCycleIds.length > 0) {
      const guildMembers = await db.collection('users').find({ guilde_id: user.guilde_id }).toArray();
      const guildMemberIds = guildMembers.map(m => m._id.toString());

      const guildCycleTotals = await db.collection('scores')
        .aggregate([
          { $match: { user_id: { $in: guildMemberIds }, cycle_id: { $in: userCycleIds } } },
          { $group: { _id: '$cycle_id', guildTotal: { $sum: '$score' } } }
        ])
        .toArray();

      const guildTotalMap = {};
      guildCycleTotals.forEach(c => { guildTotalMap[c._id] = c.guildTotal; });

      const contributionByCycle = userCycleIds
        .map(cid => {
          const userTotal = cycleStats[cid].totalScore;
          const guildTotal = guildTotalMap[cid] || 0;
          const pct = guildTotal > 0 ? Math.round((userTotal / guildTotal) * 10000) / 100 : 0;
          return { cycle_id: cid, userTotal, guildTotal, contributionPct: pct };
        })
        .filter(c => c.guildTotal > 0);

      const avgContribution = contributionByCycle.length > 0
        ? Math.round(contributionByCycle.reduce((sum, c) => sum + c.contributionPct, 0) / contributionByCycle.length * 100) / 100
        : 0;

      guildContribution = { averagePct: avgContribution, byCycle: contributionByCycle };
    }
  }

  // Performance par quartile de position (1-5, 6-10, 11-15, 16-20)
  const quartileMap = { 'Q1 (1-5)': { totalScore: 0, count: 0 }, 'Q2 (6-10)': { totalScore: 0, count: 0 }, 'Q3 (11-15)': { totalScore: 0, count: 0 }, 'Q4 (16-20)': { totalScore: 0, count: 0 } };
  for (const score of scoresWithRotations) {
    const pos = score.rotation_position;
    if (!pos) continue;
    const key = pos <= 5 ? 'Q1 (1-5)' : pos <= 10 ? 'Q2 (6-10)' : pos <= 15 ? 'Q3 (11-15)' : 'Q4 (16-20)';
    quartileMap[key].totalScore += score.score || 0;
    quartileMap[key].count += 1;
  }
  const performanceByQuartile = Object.entries(quartileMap)
    .filter(([, s]) => s.count > 0)
    .map(([quartile, s]) => ({
      quartile,
      averageScore: Math.round(s.totalScore / s.count),
      count: s.count
    }));

  // Performance par type d'attaque (R / B)
  const attackMap = {};
  for (const score of scoresWithRotations) {
    const key = score.rotation_attack || 'Inconnu';
    if (!attackMap[key]) attackMap[key] = { totalScore: 0, count: 0 };
    attackMap[key].totalScore += score.score || 0;
    attackMap[key].count += 1;
  }
  const performanceByAttack = Object.entries(attackMap)
    .map(([attack, s]) => ({
      attack,
      averageScore: Math.round(s.totalScore / s.count),
      count: s.count
    }))
    .sort((a, b) => b.averageScore - a.averageScore);

  // Performance par altération d'état
  const alterationMap = {};
  for (const score of scoresWithRotations) {
    const key = score.rotation_alteration || 'Aucune';
    if (!alterationMap[key]) alterationMap[key] = { totalScore: 0, count: 0 };
    alterationMap[key].totalScore += score.score || 0;
    alterationMap[key].count += 1;
  }
  const performanceByAlteration = Object.entries(alterationMap)
    .map(([alteration, s]) => ({
      alteration,
      averageScore: Math.round(s.totalScore / s.count),
      count: s.count
    }))
    .sort((a, b) => b.averageScore - a.averageScore);

  return {
    user: userSummary,
    stats: {
      totalScores,
      averageScore,
      totalPoints,
      bestRotation,
      worstRotation,
      bestScore: {
        score: bestScore,
        rotation_id: bestScoreDetails?.rotation_id,
        rotation_killer: bestScoreDetails?.rotation_killer,
        rotation_attack: bestScoreDetails?.rotation_attack,
        rotation_alteration: bestScoreDetails?.rotation_alteration,
        rotation_position: bestScoreDetails?.rotation_position,
        cycle_id: bestScoreDetails?.cycle_id
      },
      worstScore: {
        score: worstScore,
        rotation_id: worstScoreDetails?.rotation_id,
        rotation_killer: worstScoreDetails?.rotation_killer,
        rotation_attack: worstScoreDetails?.rotation_attack,
        rotation_alteration: worstScoreDetails?.rotation_alteration,
        rotation_position: worstScoreDetails?.rotation_position,
        cycle_id: worstScoreDetails?.cycle_id
      },
      allRotations: rotationAverages.map(r => ({
        rotation_id: r.rotation_id,
        rotation_killer: r.rotation_killer,
        rotation_attack: r.rotation_attack,
        rotation_alteration: r.rotation_alteration,
        rotation_position: r.rotation_position,
        cycle_id: r.cycle_id,
        averageScore: Math.round(r.averageScore),
        scoreCount: r.scoreCount
      })),
      ranking: {
        global: globalRank,
        totalPlayers,
        guild: guildRank,
        totalGuildPlayers,
        percentile,
        gapWithTop1
      },
      bestCycle,
      firstParticipation,
      buildsCount,
      temporalEvolution,
      missRate,
      missCount,
      recentTrend,
      rivals,
      medianScore,
      stdDeviation,
      consistencyScore,
      cyclesWithFullParticipation,
      guildContribution,
      performanceByQuartile,
      performanceByAttack,
      performanceByAlteration
    },
    filters: { cycle_id: cycle_id || null }
  };
}
