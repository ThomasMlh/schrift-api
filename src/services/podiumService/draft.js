import { getMinScoresForRanking, lookupUserAndGuild, getCurrentGuildBbsIds, getUnguildedBbsIds } from './helpers.js';

const DEFAULT_DRAFT_GUILD_ORDER = ['A', 'C', 'B', 'E', 'D'];
const DRAFT_GUILD_SIZE = 20;

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

// Liste "a,b,c" (ou tableau) -> tableau de valeurs non vides
const parseList = (value) => Array.isArray(value)
  ? value
  : String(value || '').split(',').map(v => v.trim()).filter(Boolean);

// Paramètres communs aux simulations de draft : cycle, type de classement et ordre des guildes
// (qui sert aussi de hiérarchie : la 1re guilde est la meilleure).
const resolveDraftContext = async (db, { cycle_name, year, ranking_type = 'average', guild_names }) => {
  if (!cycle_name) throw httpError(400, 'Le paramètre cycle_name est obligatoire');

  const rankingType = String(ranking_type).toLowerCase();
  if (!['average', 'total'].includes(rankingType)) throw httpError(400, 'ranking_type doit être "average" ou "total"');

  const requestedOrder = parseList(guild_names);
  const guildOrder = requestedOrder.length > 0 ? requestedOrder : DEFAULT_DRAFT_GUILD_ORDER;

  const cycleQuery = { name: cycle_name };
  if (year) cycleQuery.year = parseInt(year, 10);
  const cycle = await db.collection('cycles').findOne(cycleQuery, { sort: { created_at: -1 } });
  if (!cycle) throw httpError(404, `Cycle avec le nom "${cycle_name}" non trouvé`);

  const guildDocs = await db.collection('guildes').find({ name: { $in: guildOrder } }).toArray();
  const guildByName = new Map(guildDocs.map(g => [g.name, g]));
  const missing = guildOrder.filter(n => !guildByName.has(n));
  if (missing.length > 0) throw httpError(404, `Guilde(s) introuvable(s): ${missing.join(', ')}`);

  return {
    cycle,
    rankingType,
    scoreKey: rankingType === 'average' ? 'averageScore' : 'totalScore',
    minScores: await getMinScoresForRanking(db),
    guildOrder,
    guildByName,
  };
};

// Classement de comptes sur un cycle (moyenne ou total), du meilleur au moins bon. Le seuil
// minimum de scores du podium ne s'applique qu'au classement par moyenne, et seulement si demandé.
const rankAccountsOnCycle = (db, { cycle, rankingType, scoreKey, minScores }, bbsIds, { applyThreshold }) =>
  db.collection('scores').aggregate([
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
    ...(applyThreshold && rankingType === 'average' ? [{ $match: { totalScores: { $gte: minScores } } }] : []),
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
  ]).toArray();

// Propose une répartition des joueurs des guildes sélectionnées sur un cycle donné : classe
// tout le monde par score (moyenne ou total) et découpe par paquets de 20 dans l'ordre de
// guildes fourni (les meilleurs vont dans la 1re guilde, les 20 suivants dans la 2e, etc.).
// Les guildes figées (locked_guild_names) gardent leurs membres actuels : elles ne reçoivent
// personne, personne n'en sort, et elles sont sautées dans l'ordre des paquets de 20.
// Pur outil de simulation en lecture seule : ne modifie rien, l'admin applique manuellement
// via l'onglet Draft s'il valide la proposition.
export const getDraftProposal = async (db, { cycle_name, year, ranking_type = 'average', guild_names, excluded_bbs_ids, pinned_bbs_ids, locked_guild_names }) => {
  const context = await resolveDraftContext(db, { cycle_name, year, ranking_type, guild_names });
  const { rankingType: normalizedRankingType, scoreKey, minScores, guildOrder, guildByName } = context;

  const lockedNames = new Set(parseList(locked_guild_names).filter(n => guildOrder.includes(n)));
  // Guildes réellement redistribuées, dans l'ordre choisi (les figées sont sautées)
  const draftOrder = guildOrder.filter(n => !lockedNames.has(n));

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
  const excludedBbsIds = new Set(parseList(excluded_bbs_ids));
  const pinnedBbsIds = new Set(parseList(pinned_bbs_ids));

  const candidateBbsIds = [...new Set([...currentGuildByBbsId.keys(), ...unguildedBbsIds])]
    .filter(id => !excludedBbsIds.has(id) && !lockedBbsIds.has(id));

  const meta = {
    cycleName: cycle_name,
    rankingType: normalizedRankingType,
    chunkSize: DRAFT_GUILD_SIZE,
    guildOrder,
    lockedGuilds: [...lockedNames],
    ...(normalizedRankingType === 'average' && minScores > 0 && { minScoresRequired: minScores }),
  };

  // Classement sur le cycle (le seuil de scores ne s'applique qu'aux candidats)
  const rankAccounts = (bbsIds, { applyThreshold }) => rankAccountsOnCycle(db, context, bbsIds, { applyThreshold });

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

const DEFAULT_REPLACEMENT_TOLERANCE = 5; // % de score en moins accepté pour un remplaçant "équivalent"
const DEFAULT_SUGGESTIONS = 5;

/**
 * Remplacement ciblé : pour des joueurs d'une guilde, propose des remplaçants de score équivalent
 * (jusqu'à `tolerance` % de moins) ou supérieur, pris UNIQUEMENT dans les guildes inférieures de
 * l'ordre (hiérarchie) ou parmi les joueurs sans guilde : les membres de la guilde visée et des
 * guildes supérieures ne sont jamais proposés. Une recommandation associe à chaque joueur remplacé
 * (du plus fort au moins fort) le meilleur remplaçant encore libre. Simulation en lecture seule.
 * Sans `replace_bbs_ids`, renvoie seulement les membres classés de la guilde (pour les choisir).
 */
export const getDraftReplacement = async (db, {
  cycle_name, year, ranking_type = 'average', guild_names, target_guild, replace_bbs_ids,
  tolerance = DEFAULT_REPLACEMENT_TOLERANCE, limit = DEFAULT_SUGGESTIONS,
}) => {
  const context = await resolveDraftContext(db, { cycle_name, year, ranking_type, guild_names });
  const { scoreKey, guildOrder, guildByName } = context;

  const targetIndex = guildOrder.indexOf(target_guild);
  if (targetIndex === -1) throw httpError(400, 'target_guild doit faire partie de l\'ordre des guildes');
  const tolerancePct = Number(tolerance);
  if (!Number.isFinite(tolerancePct) || tolerancePct < 0 || tolerancePct > 50) throw httpError(400, 'tolerance doit être comprise entre 0 et 50');
  const maxSuggestions = Math.min(20, Math.max(1, parseInt(limit, 10) || DEFAULT_SUGGESTIONS));

  // Membres actuels de la guilde visée, classés (tous, même sous le seuil de scores)
  const targetMembers = await getCurrentGuildBbsIds(db, guildByName.get(target_guild)._id.toString());
  const roster = targetMembers.length ? await rankAccountsOnCycle(db, context, targetMembers, { applyThreshold: false }) : [];

  const higherGuilds = guildOrder.slice(0, targetIndex);
  const lowerGuilds = guildOrder.slice(targetIndex + 1);
  const meta = {
    cycleName: cycle_name,
    rankingType: context.rankingType,
    targetGuild: target_guild,
    higherGuilds,
    lowerGuilds,
    tolerance: tolerancePct,
  };

  const toReplace = new Set(parseList(replace_bbs_ids));
  const replaced = roster.filter(p => toReplace.has(p.bbs_id));
  if (replaced.length === 0) return { roster, replacements: [], meta };

  // Remplaçants possibles : membres des guildes inférieures + joueurs sans guilde
  const sourceGuildByBbsId = new Map();
  for (const name of lowerGuilds) {
    for (const bbsId of await getCurrentGuildBbsIds(db, guildByName.get(name)._id.toString())) sourceGuildByBbsId.set(bbsId, name);
  }
  const unguilded = await getUnguildedBbsIds(db);
  const candidateIds = [...new Set([...sourceGuildByBbsId.keys(), ...unguilded])].filter(id => !targetMembers.includes(id));
  const candidates = candidateIds.length
    ? (await rankAccountsOnCycle(db, context, candidateIds, { applyThreshold: true }))
      .map(c => ({ ...c, currentGuildName: sourceGuildByBbsId.get(c.bbs_id) || null }))
    : [];

  const withDelta = (candidate, reference) => {
    const delta = candidate[scoreKey] - reference[scoreKey];
    return { ...candidate, delta, deltaPercent: reference[scoreKey] > 0 ? Math.round((delta / reference[scoreKey]) * 1000) / 10 : null };
  };
  const eligibleFor = (player) => candidates.filter(c => c[scoreKey] >= player[scoreKey] * (1 - tolerancePct / 100));

  // Recommandation : le joueur remplacé le plus fort choisit en premier le meilleur remplaçant libre
  const taken = new Set();
  const recommended = new Map();
  for (const player of [...replaced].sort((a, b) => b[scoreKey] - a[scoreKey])) {
    const pick = eligibleFor(player).find(c => !taken.has(c.bbs_id));
    if (pick) {
      taken.add(pick.bbs_id);
      recommended.set(player.bbs_id, pick.bbs_id);
    }
  }

  return {
    roster,
    replacements: replaced.map(player => ({
      player,
      suggestions: eligibleFor(player).slice(0, maxSuggestions).map(c => withDelta(c, player)),
      eligible_count: eligibleFor(player).length,
      recommended_bbs_id: recommended.get(player.bbs_id) || null,
    })),
    meta,
  };
};
