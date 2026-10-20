import { parseDate } from '../killerRecords.js';

// Minimum number of rotations played to appear in an average-based ranking (otherwise a player with
// 1-2 excellent scores could beat regular players with many more scores). Does not apply to
// single-rotation views (one score at most) nor to misses (a count, not an average). Set by the admin
// (app_settings/podium); 0 = disabled. Fallback when no setting exists yet.
const DEFAULT_MIN_SCORES_FOR_RANKING = 0;

export const getMinScoresForRanking = async (db) => {
  const settings = await db.collection('app_settings').findOne({ _id: 'podium' });
  return typeof settings?.min_scores_for_ranking === 'number'
    ? settings.min_scores_for_ranking
    : DEFAULT_MIN_SCORES_FOR_RANKING;
};

// Shared pipeline joining users (Discord identity only: avatar/global_name) from the document's
// user_id, and guilds from the document's own guild_id (the SCORE's guild_id/bbs_name, never the
// user's current guild/name: one user may own several bbs accounts ranked separately in different
// guilds).
export const lookupUserAndGuild = () => {
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

// Alias kept for readability at existing call sites (same pipeline).
export const lookupUserByUserId = lookupUserAndGuild;

// bbs_ids currently attached to a guild (users.bbs_accounts[].guilde_id), to attribute a score to
// the account's CURRENT guild rather than the guild stored on the score at entry time (useful after a
// mid-cycle guild change).
export const getCurrentGuildBbsIds = async (db, guildId) => {
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

// bbs_ids of accounts that currently belong to no guild, so the automatic draft can propose them as
// candidates like guild members.
export const getUnguildedBbsIds = async (db) => {
  const users = await db.collection('users').find(
    { 'bbs_accounts.guilde_id': null },
    { projection: { 'bbs_accounts.bbs_id': 1, 'bbs_accounts.guilde_id': 1 } }
  ).toArray();

  const bbsIds = [];
  for (const user of users) {
    for (const account of user.bbs_accounts || []) {
      if (!account.guilde_id && account.bbs_id) bbsIds.push(account.bbs_id);
    }
  }
  return bbsIds;
};

// Guild match condition: scores of the accounts currently in the guild (through bbs_id). Scores
// without a bbs_id (legacy) never match.
export const buildGuildMatch = (currentBbsIds) => ({ bbs_id: { $in: currentBbsIds } });

const DAY_MS = 24 * 60 * 60 * 1000;

// A cycle is in progress between the start of its first rotation and the end of its last one.
export const isCycleInProgress = (cycle, now = Date.now()) => {
  const rotations = cycle?.rotations || [];
  if (rotations.length === 0) return false;
  const start = parseDate(rotations[0].start_date);
  const end = parseDate(rotations[rotations.length - 1].end_date || rotations[rotations.length - 1].start_date);
  return start > 0 && start <= now && now < end + DAY_MS;
};

// Scope of a guild on a cycle:
//  - running cycle: the guild's CURRENT members (a player moved mid-cycle appears in their new
//    guild with all their scores);
//  - past cycle: the scores entered for this guild on that cycle (the score's guild_id), so old
//    podiums keep the guilds of that time, even after a draft.
// Without a known cycle, current members are used.
export const getGuildScoreMatch = async (db, cycle, guildId, now = Date.now()) =>
  !cycle || isCycleInProgress(cycle, now)
    ? buildGuildMatch(await getCurrentGuildBbsIds(db, guildId))
    : { guild_id: guildId };

// The guild's accounts on a cycle, with the same rule as getGuildScoreMatch.
export const getGuildBbsIdsForCycle = async (db, cycle, guildId, now = Date.now()) =>
  !cycle || isCycleInProgress(cycle, now)
    ? getCurrentGuildBbsIds(db, guildId)
    : db.collection('scores').distinct('bbs_id', { cycle_id: cycle._id.toString(), guild_id: guildId, bbs_id: { $ne: null } });

// Once the guild filter is applied, every row belongs to that guild by construction: display its
// name rather than the (possibly outdated, see buildGuildMatch) guild_id stored on the score.
export const overrideGuildName = (results, guildName) => {
  if (guildName) results.forEach(r => { r.guild_name = guildName; });
  return results;
};

// Ranks with ties
export const applyRanks = (results, scoreKey) => {
  let currentRank = 1;
  let previousScore = null;
  return results.map((player, index) => {
    const score = player[scoreKey];
    if (index > 0 && previousScore !== null && score !== previousScore) currentRank++;
    previousScore = score;
    return { rank: currentRank, ...player };
  });
}

// Keeps the ranked rows of some accounts only (?bbs_ids=a,b: "followed players" filter). Applied after
// ranking so each row keeps its overall rank.
export const keepBbsIds = (results, bbsIds) => {
  if (bbsIds === undefined || bbsIds === null) return results;
  const ids = new Set((Array.isArray(bbsIds) ? bbsIds : String(bbsIds).split(',')).map((id) => id.trim()).filter(Boolean));
  return results.filter((row) => ids.has(row.bbs_id));
};

// Paginates an already sorted array
export const paginate = (results, page, limit) => {
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
