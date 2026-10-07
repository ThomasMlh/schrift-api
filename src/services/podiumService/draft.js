import { getMinScoresForRanking, lookupUserAndGuild, getCurrentGuildBbsIds, getUnguildedBbsIds } from './helpers.js';

const DEFAULT_DRAFT_GUILD_ORDER = ['A', 'C', 'B', 'E', 'D'];
const DRAFT_GUILD_SIZE = 20;

// Propose une répartition des joueurs des guildes sélectionnées sur un cycle donné : classe
// tout le monde par score (moyenne ou total) et découpe par paquets de 20 dans l'ordre de
// guildes fourni (les meilleurs vont dans la 1re guilde, les 20 suivants dans la 2e, etc.).
// Les guildes figées (locked_guild_names) gardent leurs membres actuels : elles ne reçoivent
// personne, personne n'en sort, et elles sont sautées dans l'ordre des paquets de 20.
// Pur outil de simulation en lecture seule : ne modifie rien, l'admin applique manuellement
// via l'onglet Draft s'il valide la proposition.
export const getDraftProposal = async (db, { cycle_name, year, ranking_type = 'average', guild_names, excluded_bbs_ids, pinned_bbs_ids, locked_guild_names }) => {
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
  const parseNameList = (value) => Array.isArray(value)
    ? value
    : String(value || '').split(',').map(n => n.trim()).filter(Boolean);
  const lockedNames = new Set(parseNameList(locked_guild_names).filter(n => guildOrder.includes(n)));
  // Guildes réellement redistribuées, dans l'ordre choisi (les figées sont sautées)
  const draftOrder = guildOrder.filter(n => !lockedNames.has(n));

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
  for (const name of draftOrder) {
    const guildId = guildByName.get(name)._id.toString();
    const bbsIds = await getCurrentGuildBbsIds(db, guildId);
    for (const bbsId of bbsIds) currentGuildByBbsId.set(bbsId, name);
  }
  // Membres des guildes figées : hors du pool de candidats, affichés tels quels dans leur guilde
  const lockedMembers = new Map(); // nom de guilde -> bbs_id[]
  for (const name of lockedNames) {
    lockedMembers.set(name, await getCurrentGuildBbsIds(db, guildByName.get(name)._id.toString()));
  }
  const lockedBbsIds = new Set([...lockedMembers.values()].flat());
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
    .filter(id => !excludedBbsIds.has(id) && !lockedBbsIds.has(id));

  const scoreKey = normalizedRankingType === 'average' ? 'averageScore' : 'totalScore';
  const meta = {
    cycleName: cycle_name,
    rankingType: normalizedRankingType,
    chunkSize: DRAFT_GUILD_SIZE,
    guildOrder,
    lockedGuilds: [...lockedNames],
    ...(normalizedRankingType === 'average' && minScores > 0 && { minScoresRequired: minScores }),
  };

  // Classement des comptes demandés sur le cycle (le seuil de scores ne s'applique qu'aux candidats)
  const buildPipeline = (bbsIds, applyThreshold) => [
    { $match: { cycle_id: cycle._id.toString(), bbs_id: { $in: bbsIds } } },
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
    ...(applyThreshold && normalizedRankingType === 'average' ? [{ $match: { totalScores: { $gte: minScores } } }] : []),
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
    { $sort: { [scoreKey]: -1 } },
  ];
  const rankAccounts = (bbsIds, { applyThreshold }) =>
    db.collection('scores').aggregate(buildPipeline(bbsIds, applyThreshold)).toArray();

  // Guildes figées : leurs membres actuels, classés par score sur le cycle, sans rang global
  const lockedGuilds = new Map();
  for (const [name, bbsIds] of lockedMembers) {
    const players = bbsIds.length ? await rankAccounts(bbsIds, { applyThreshold: false }) : [];
    lockedGuilds.set(name, {
      guild_name: name,
      locked: true,
      member_count: bbsIds.length,
      players: players.map(p => ({ ...p, overallRank: null, currentGuildName: name, isPinned: false })),
    });
  }
  const assemble = (draftedGuilds) => {
    const drafted = new Map(draftedGuilds.map(g => [g.guild_name, g]));
    return guildOrder.map(name => lockedGuilds.get(name) || drafted.get(name));
  };

  if (candidateBbsIds.length === 0) {
    return {
      guilds: assemble(draftOrder.map(name => ({ guild_name: name, players: [] }))),
      leftover: [],
      meta: { ...meta, totalCandidates: 0 },
    };
  }

  const ranked = await rankAccounts(candidateBbsIds, { applyThreshold: true });
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

  const draftedGuilds = draftOrder.map((name) => {
    const pinnedHere = withCurrentGuild.filter(p => p.isPinned && p.currentGuildName === name);
    const slotsLeft = Math.max(0, DRAFT_GUILD_SIZE - pinnedHere.length);
    const floatingHere = floating.slice(floatingCursor, floatingCursor + slotsLeft);
    floatingCursor += floatingHere.length;
    const players = [...pinnedHere, ...floatingHere].sort((a, b) => b[scoreKey] - a[scoreKey]);
    return { guild_name: name, players };
  });
  const leftover = floating.slice(floatingCursor);

  return {
    guilds: assemble(draftedGuilds),
    leftover,
    meta: { ...meta, totalCandidates: withCurrentGuild.length },
  };
}
