// Minimum fields to resolve a display name through getUserDisplayName
export const USER_DISPLAY = { bbs_name: 1, global_name: 1, username: 1 };

// USER_DISPLAY + _id, to build a Map keyed by _id
export const USER_DISPLAY_WITH_ID = { _id: 1, bbs_name: 1, global_name: 1, username: 1 };

// Author fields used to enrich builds
export const USER_BUILD = {
  discord_id: 1, username: 1, global_name: 1, bbs_name: 1, avatar: 1, is_admin: 1
};

// $project used inside $lookup pipelines (scores, cycles)
export const USER_SCORES_LOOKUP = {
  _id: 1, discord_id: 1, avatar: 1, bbs_id: 1, bbs_name: 1,
  global_name: 1, guilde_id: 1, role: 1, username: 1
};

// Full user list/detail response
export const USER_FULL = {
  _id: 1, discord_id: 1, username: 1, avatar: 1, banner: 1, guilde_id: 1,
  role: 1, is_admin: 1, last_login: 1, global_name: 1, bbs_id: 1, bbs_name: 1,
  bbs_accounts: 1,
  is_authorized: 1, is_banned: 1, ban_reason: 1, banned_at: 1
};
