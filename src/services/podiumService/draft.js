import { getMinScoresForRanking, lookupUserAndGuild, getCurrentGuildBbsIds, getUnguildedBbsIds } from './helpers.js';

const DEFAULT_DRAFT_GUILD_ORDER = ['A', 'C', 'B', 'E', 'D'];
const DRAFT_GUILD_SIZE = 20;

// Propose une répartition des joueurs des guildes sélectionnées sur un cycle donné : classe
// tout le monde par score (moyenne ou total) et découpe par paquets de 20 dans l'ordre de
// guildes fourni (les meilleurs vont dans la 1re guilde, les 20 suivants dans la 2e, etc.).
// Pur outil de simulation en lecture seule : ne modifie rien, l'admin applique manuellement
// via l'onglet Draft s'il valide la proposition.
export const getDraftProposal = async (db, { cycle_name, year, ranking_type = 'average', guild_names, excluded_bbs_ids, pinned_bbs_ids }) => {
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
  // bougerait par rapport à la répartition d'aujourd'hui, plus les comptes sans guilde (agents
  // libres) qui doivent pouvoir intégrer une guilde via la draft, pas seulement en être exclus.
  const currentGuildByBbsId = new Map();
  for (const name of guildOrder) {
    const guildId = guildByName.get(name)._id.toString();
    const bbsIds = await getCurrentGuildBbsIds(db, guildId);
    for (const bbsId of bbsIds) currentGuildByBbsId.set(bbsId, name);
  }
  const unguildedBbsIds = await getUnguildedBbsIds(db);
  // "Et si" : exclus complètement de la simulation (aucune guilde), ou garantis de rester
  // dans leur guilde ACTUELLE quel que soit leur score (ex: un chef qu'on ne veut pas voir
  // bouger). Les deux listes viennent du front sous forme de bbs_id séparés par des virgules.
  const parseIdList = (value) => Array.isArray(value)
    ? value
    : String(value || '').split(',').map(s => s.trim()).filter(Boolean);
  const excludedBbsIds = new Set(parseIdList(excluded_bbs_ids));
  const pinnedBbsIds = new Set(parseIdList(pinned_bbs_ids));

  const candidateBbsIds = [...new Set([...currentGuildByBbsId.keys(), ...unguildedBbsIds])]
    .filter(id => !excludedBbsIds.has(id));

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
  const withCurrentGuild = ranked.map((p, i) => {
    const currentGuildName = currentGuildByBbsId.get(p.bbs_id) || null;
    return {
      ...p,
      overallRank: i + 1,
      currentGuildName,
      // "Rester dans sa guilde actuelle" n'a pas de sens pour un agent libre (pas de guilde
      // actuelle) : on ignore le pin plutôt que de le laisser disparaître du résultat.
      isPinned: pinnedBbsIds.has(p.bbs_id) && !!currentGuildName,
    };
  });

  // Les joueurs épinglés occupent d'abord une place dans leur guilde actuelle ; le reste des
  // places de chaque guilde (dans l'ordre choisi) est comblé par les meilleurs scores restants.
  const floating = withCurrentGuild.filter(p => !p.isPinned);
  let floatingCursor = 0;
  const scoreKey = normalizedRankingType === 'average' ? 'averageScore' : 'totalScore';

  const guilds = guildOrder.map((name) => {
    const pinnedHere = withCurrentGuild.filter(p => p.isPinned && p.currentGuildName === name);
    const slotsLeft = Math.max(0, DRAFT_GUILD_SIZE - pinnedHere.length);
    const floatingHere = floating.slice(floatingCursor, floatingCursor + slotsLeft);
    floatingCursor += floatingHere.length;
    const players = [...pinnedHere, ...floatingHere].sort((a, b) => b[scoreKey] - a[scoreKey]);
    return { guild_name: name, players };
  });
  const leftover = floating.slice(floatingCursor);

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
