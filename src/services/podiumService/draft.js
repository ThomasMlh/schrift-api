import { getMinScoresForRanking, lookupUserAndGuild, getCurrentGuildBbsIds, getUnguildedBbsIds } from './helpers.js';

const DEFAULT_DRAFT_GUILD_ORDER = ['A', 'C', 'B', 'E', 'D'];
const DRAFT_GUILD_SIZE = 20;

// Average ranking score (average or total) of a list of players; null when empty
const averageOf = (players, scoreKey) => players.length
  ? Math.round(players.reduce((sum, p) => sum + p[scoreKey], 0) / players.length)
  : null;

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

// "a,b,c" list (or array) -> array of non-empty values
const parseList = (value) => Array.isArray(value)
  ? value
  : String(value || '').split(',').map(v => v.trim()).filter(Boolean);

// Parameters shared by draft simulations: cycle, ranking type and guild order (which is also the
// hierarchy: the first guild is the strongest).
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

// Ranks accounts on a cycle (average or total), best first. The podium's minimum score count only
// applies to the average ranking, and only when requested.
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

// Proposes a split of the selected guilds' players on a cycle: ranks everyone by score (average or
// total) and fills guilds by chunks of 20 in the given order (the best go to the first guild, the
// next 20 to the second, and so on).
// Locked guilds (locked_guild_names) keep their current members: nobody joins or leaves them, and
// they are skipped in the chunk order.
// Read-only simulation: nothing is changed, the admin applies the proposal manually from the Draft tab.
export const getDraftProposal = async (db, { cycle_name, year, ranking_type = 'average', guild_names, excluded_bbs_ids, pinned_bbs_ids, locked_guild_names }) => {
  const context = await resolveDraftContext(db, { cycle_name, year, ranking_type, guild_names });
  const { rankingType: normalizedRankingType, scoreKey, minScores, guildOrder, guildByName } = context;

  const lockedNames = new Set(parseList(locked_guild_names).filter(n => guildOrder.includes(n)));
  // Guilds actually redistributed, in the chosen order (locked ones are skipped)
  const draftOrder = guildOrder.filter(n => !lockedNames.has(n));

  // Candidate pool: current members of the involved guilds (through bbs_accounts, see
  // getCurrentGuildBbsIds) with their current guild, so the front end can show who would move, plus
  // guildless accounts (free agents) that must be able to join a guild through the draft.
  const currentGuildByBbsId = new Map();
  for (const name of draftOrder) {
    const guildId = guildByName.get(name)._id.toString();
    const bbsIds = await getCurrentGuildBbsIds(db, guildId);
    for (const bbsId of bbsIds) currentGuildByBbsId.set(bbsId, name);
  }
  // Locked guild members: outside the candidate pool, shown as-is in their guild
  const lockedMembers = new Map(); // Guild name -> bbs_id[]
  for (const name of lockedNames) {
    lockedMembers.set(name, await getCurrentGuildBbsIds(db, guildByName.get(name)._id.toString()));
  }
  const lockedBbsIds = new Set([...lockedMembers.values()].flat());
  const unguildedBbsIds = await getUnguildedBbsIds(db);
  // What-if: fully excluded from the simulation (no guild), or guaranteed to stay in their CURRENT
  // guild whatever their score (e.g. a leader who should not move). Both lists come from the front end
  // as comma-separated bbs_ids.
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

  // Ranking on the cycle (the score threshold only applies to candidates)
  const rankAccounts = (bbsIds, { applyThreshold }) => rankAccountsOnCycle(db, context, bbsIds, { applyThreshold });

  // Locked guilds: their current members, ranked by score on the cycle, without a global rank
  const lockedGuilds = new Map();
  for (const [name, bbsIds] of lockedMembers) {
    const players = bbsIds.length ? await rankAccounts(bbsIds, { applyThreshold: false }) : [];
    lockedGuilds.set(name, {
      guild_name: name,
      locked: true,
      member_count: bbsIds.length,
      players: players.map(p => ({ ...p, overallRank: null, currentGuildName: name, isPinned: false })),
      average_before: averageOf(players, scoreKey),
      average_after: averageOf(players, scoreKey),
    });
  }

  // Average of each redistributed guild BEFORE the draft: its current members, with the same ranking
  // rules as candidates (score threshold included), including players excluded from the simulation
  // since they are part of the guild today.
  const currentMemberIds = [...currentGuildByBbsId.keys()];
  const currentRanked = currentMemberIds.length ? await rankAccounts(currentMemberIds, { applyThreshold: true }) : [];
  const averageBeforeByGuild = new Map(draftOrder.map(name => [
    name,
    averageOf(currentRanked.filter(p => currentGuildByBbsId.get(p.bbs_id) === name), scoreKey),
  ]));

  const assemble = (draftedGuilds) => {
    const drafted = new Map(draftedGuilds.map(g => [g.guild_name, {
      ...g,
      average_before: averageBeforeByGuild.get(g.guild_name) ?? null,
      average_after: averageOf(g.players, scoreKey),
    }]));
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
      // "Stay in the current guild" is meaningless for a free agent (no current guild): the pin is ignored
      // rather than dropping the player from the result.
      isPinned: pinnedBbsIds.has(p.bbs_id) && !!currentGuildName,
    };
  });

  // Pinned players first take a spot in their current guild; the remaining spots of each guild (in
  // the chosen order) are filled with the best remaining scores.
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

const DEFAULT_REPLACEMENT_TOLERANCE = 5; // % below the original score still accepted for an "equivalent" replacement
const DEFAULT_SUGGESTIONS = 5;

/**
 * Targeted replacement: for some players of a guild, proposes replacements with an equivalent (up to
 * `tolerance` % lower) or higher score, taken ONLY from lower guilds in the order (hierarchy) or from
 * guildless players: members of the target guild and of higher guilds are never proposed. The
 * recommendation pairs each replaced player (strongest first) with the best replacement still
 * available. Read-only simulation.
 * Without `replace_bbs_ids`, only returns the guild's ranked members (to pick from).
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

  // Current members of the target guild, ranked (all of them, even below the score threshold)
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

  // Possible replacements: members of lower guilds + guildless players
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

  // Recommendation: the strongest replaced player picks the best free replacement first
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
