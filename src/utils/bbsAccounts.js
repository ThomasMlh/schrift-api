import { ObjectId } from "mongodb";
import { escapeRegex } from "./regexUtils.js";

// Helpers for a user's multiple bbs accounts (main + alts).
// bbs_accounts: [{ bbs_id, bbs_name, guilde_id, role, is_primary, linked_at }]

// The user's bbs account matching a bbs_id.
export const findAccount = (user, bbsId) =>
  (user?.bbs_accounts || []).find(a => a.bbs_id === bbsId) || null;

// A user's main account (is_primary, or the first one by default).
export const getPrimaryAccount = (bbsAccounts) =>
  (bbsAccounts || []).find(a => a.is_primary) || (bbsAccounts || [])[0] || null;

// Root bbs_id/bbs_name/guilde_id/role fields: read-only mirror of the main account, kept so existing
// projections and searches reading them directly keep working.
export const deriveMirrorFields = (bbsAccounts) => {
  const primary = getPrimaryAccount(bbsAccounts);
  return {
    bbs_id: primary?.bbs_id || null,
    bbs_name: primary?.bbs_name || null,
    guilde_id: primary?.guilde_id || null,
    role: primary?.role || null
  };
};

// Leader/officer grants embedded in the JWT: one per account with an elevated role, scoped to THAT
// account's guild (never merged into a single role/guilde_id pair).
export const buildGuildRoles = (bbsAccounts) =>
  (bbsAccounts || [])
    .filter(a => a.role === "chef" || a.role === "sous-chef")
    .map(a => ({ bbs_id: a.bbs_id, guilde_id: a.guilde_id, role: a.role }));

// Creates or updates a user's MAIN bbs account (is_primary: true). The main account may exist before
// it has a bbs_id (e.g. guild/role assigned while waiting for the game account link), so the entry is
// found by is_primary first, and by bbs_id only as a fallback.
export const upsertPrimaryAccount = (existingAccounts, { bbsId, bbsName, guildeId, role }) => {
  const accounts = [...(existingAccounts || [])];
  const hasData = bbsId || bbsName || guildeId || role;

  let index = accounts.findIndex(a => a.is_primary);
  if (index === -1 && bbsId) {
    index = accounts.findIndex(a => a.bbs_id === bbsId);
  }

  if (index === -1) {
    if (!hasData) return accounts; // Nothing to create
    accounts.unshift({
      bbs_id: bbsId || null,
      bbs_name: bbsName || null,
      guilde_id: guildeId || null,
      role: role || null,
      is_primary: true,
      linked_at: new Date()
    });
    return accounts;
  }

  accounts[index] = {
    ...accounts[index],
    bbs_id: bbsId || accounts[index].bbs_id,
    bbs_name: bbsName || accounts[index].bbs_name,
    guilde_id: guildeId !== undefined ? guildeId : accounts[index].guilde_id,
    role: role !== undefined ? role : accounts[index].role,
    is_primary: true
  };

  return accounts;
};

// Adds an alt account (not main by default). Throws if this bbs_id is already attached to the user.
export const addAltAccount = (existingAccounts, { bbsId, bbsName, guildeId, role }) => {
  const accounts = [...(existingAccounts || [])];
  if (!bbsId) {
    throw Object.assign(new Error("bbs_id requis pour ajouter un compte"), { statusCode: 400 });
  }
  if (accounts.some(a => a.bbs_id === bbsId)) {
    throw Object.assign(new Error("Ce compte bbs est déjà rattaché à cet utilisateur"), { statusCode: 400 });
  }
  accounts.push({
    bbs_id: bbsId,
    bbs_name: bbsName || null,
    guilde_id: guildeId || null,
    role: role || null,
    is_primary: accounts.length === 0,
    linked_at: new Date()
  });
  return accounts;
};

// Updates bbs_name/guilde_id/role of an existing account (found by bbs_id).
export const updateAccount = (existingAccounts, bbsId, { bbsName, guildeId, role }) => {
  const accounts = [...(existingAccounts || [])];
  const index = accounts.findIndex(a => a.bbs_id === bbsId);
  if (index === -1) {
    throw Object.assign(new Error("Compte bbs introuvable pour cet utilisateur"), { statusCode: 404 });
  }
  accounts[index] = {
    ...accounts[index],
    bbs_name: bbsName !== undefined ? bbsName : accounts[index].bbs_name,
    guilde_id: guildeId !== undefined ? guildeId : accounts[index].guilde_id,
    role: role !== undefined ? role : accounts[index].role
  };
  return accounts;
};

// Renames an existing account's bbs_id (e.g. a typo at creation). Only touches the bbs_accounts
// array: scores entered under the old bbs_id are migrated separately by the caller (see the route),
// so the history stays attached to the right account.
export const renameAccountBbsId = (existingAccounts, oldBbsId, newBbsId) => {
  const accounts = [...(existingAccounts || [])];
  const index = accounts.findIndex(a => a.bbs_id === oldBbsId);
  if (index === -1) {
    throw Object.assign(new Error("Compte bbs introuvable pour cet utilisateur"), { statusCode: 404 });
  }
  if (accounts.some((a, i) => i !== index && a.bbs_id === newBbsId)) {
    throw Object.assign(new Error("Ce nouvel ID bbs est déjà utilisé par un autre compte de cet utilisateur"), { statusCode: 400 });
  }
  accounts[index] = { ...accounts[index], bbs_id: newBbsId };
  return accounts;
};

// Ensures no OTHER user already has an account with this bbs_id: a bbs_id identifies a single game
// account, never shared between two Discord users.
export const assertBbsIdAvailable = async (db, bbsId, excludeUserId) => {
  const conflict = await db.collection("users").findOne({
    "bbs_accounts.bbs_id": bbsId,
    ...(excludeUserId ? { _id: { $ne: new ObjectId(excludeUserId) } } : {})
  });
  if (conflict) {
    throw Object.assign(new Error("Ce bbs_id est déjà rattaché à un autre utilisateur"), { statusCode: 400 });
  }
};

// Removes an account. The main account can only be removed when no other account remains (otherwise
// another account must first be made main through setPrimaryAccount).
export const removeAccount = (existingAccounts, bbsId) => {
  const accounts = [...(existingAccounts || [])];
  const index = accounts.findIndex(a => a.bbs_id === bbsId);
  if (index === -1) {
    throw Object.assign(new Error("Compte bbs introuvable pour cet utilisateur"), { statusCode: 404 });
  }
  if (accounts[index].is_primary && accounts.length > 1) {
    throw Object.assign(new Error("Impossible de retirer le compte principal : définissez d'abord un autre compte comme principal"), { statusCode: 400 });
  }
  accounts.splice(index, 1);
  return accounts;
};

// Changes the main account (switches the root bbs_id/bbs_name/guilde_id/role mirror).
export const setPrimaryAccount = (existingAccounts, bbsId) => {
  const accounts = [...(existingAccounts || [])];
  const index = accounts.findIndex(a => a.bbs_id === bbsId);
  if (index === -1) {
    throw Object.assign(new Error("Compte bbs introuvable pour cet utilisateur"), { statusCode: 404 });
  }
  return accounts.map((a, i) => ({ ...a, is_primary: i === index }));
};

// Counts the bbs accounts (all users) holding a role in a guild, optionally excluding one account
// (the one being edited).
export const countGuildRoleHolders = async (db, guildeId, role, excludeBbsId) => {
  if (!guildeId || !role) return 0;

  const pipeline = [
    { $match: { "bbs_accounts.guilde_id": guildeId, "bbs_accounts.role": role } },
    { $unwind: "$bbs_accounts" },
    { $match: { "bbs_accounts.guilde_id": guildeId, "bbs_accounts.role": role } }
  ];
  if (excludeBbsId) {
    pipeline.push({ $match: { "bbs_accounts.bbs_id": { $ne: excludeBbsId } } });
  }
  pipeline.push({ $count: "count" });

  const result = await db.collection("users").aggregate(pipeline).toArray();
  return result[0]?.count || 0;
};

// Enforces "1 leader / at most 2 officers per guild" per account (not per user); throws
// { statusCode: 400 } when violated.
export const assertRoleAvailable = async (db, guildeId, role, excludeBbsId) => {
  if (role === "chef") {
    const count = await countGuildRoleHolders(db, guildeId, "chef", excludeBbsId);
    if (count > 0) {
      throw Object.assign(new Error("Il ne peut y avoir qu'un seul chef dans une guilde"), { statusCode: 400 });
    }
  }
  if (role === "sous-chef") {
    const count = await countGuildRoleHolders(db, guildeId, "sous-chef", excludeBbsId);
    if (count >= 2) {
      throw Object.assign(new Error("Il ne peut y avoir que deux sous-chefs dans une guilde"), { statusCode: 400 });
    }
  }
};

// Checks that each submitted bbs_id (scores: [{user_id, bbs_id, guild_id}]) belongs to the target
// user_id and that the account is attached to the score's guild (prevents a guild A leader from
// entering a score for an alt attached to guild B through a wrong guild_id).
// Returns a Map `${user_id}-${bbs_id}` -> account, used to store bbs_name on the score from the
// database rather than from a client-provided value.
export const resolveScoreAccounts = async (db, scores) => {
  const userIds = [...new Set(scores.map(s => s.user_id))];
  const users = await db.collection("users").find(
    { _id: { $in: userIds.map(id => new ObjectId(id)) } },
    { projection: { bbs_accounts: 1 } }
  ).toArray();
  const userMap = new Map(users.map(u => [u._id.toString(), u]));

  const accountMap = new Map();
  for (const score of scores) {
    const user = userMap.get(score.user_id);
    const account = user && (user.bbs_accounts || []).find(a => a.bbs_id === score.bbs_id);
    if (!account) {
      throw Object.assign(new Error(`Le compte bbs ${score.bbs_id} n'appartient pas à l'utilisateur ${score.user_id}`), { statusCode: 400 });
    }
    if (account.guilde_id && score.guild_id && account.guilde_id !== score.guild_id) {
      throw Object.assign(new Error(`Le compte bbs ${score.bbs_id} appartient à une autre guilde que celle indiquée`), { statusCode: 400 });
    }
    accountMap.set(`${score.user_id}-${score.bbs_id}`, account);
  }
  return accountMap;
};

// Roster of the bbs accounts attached to a guild (one item per account, possibly several per user if
// they have several accounts in that guild). Each row identifies both the owning user
// (avatar/global_name/discord_id) and the exact account (bbs_id/bbs_name).
export const getGuildAccountRoster = async (db, guildeId) => {
  const users = await db.collection("users").find(
    { "bbs_accounts.guilde_id": guildeId },
    { projection: { discord_id: 1, global_name: 1, username: 1, avatar: 1, bbs_accounts: 1 } }
  ).toArray();

  return users.flatMap(user =>
    (user.bbs_accounts || [])
      .filter(a => a.guilde_id === guildeId)
      .map(account => ({
        _id: user._id,
        user_id: user._id.toString(),
        discord_id: user.discord_id,
        global_name: user.global_name,
        username: user.username,
        avatar: user.avatar,
        bbs_id: account.bbs_id,
        bbs_name: account.bbs_name,
        role: account.role,
        is_primary: account.is_primary
      }))
  );
};

// Guildless bbs accounts (all users), one item per account rather than per user: a user whose main
// account has a guild but whose alt does not gets that alt listed here.
// Returns { accounts, totalCount } for pagination (optional search, skip, limit).
export const getAccountsWithoutGuild = async (db, { search, skip = 0, limit = 50 } = {}) => {
  const pipeline = [
    { $match: { "bbs_accounts.0": { $exists: true } } },
    { $unwind: "$bbs_accounts" },
    { $match: { $or: [
      { "bbs_accounts.guilde_id": null },
      { "bbs_accounts.guilde_id": { $exists: false } }
    ] } }
  ];

  if (search && search.trim()) {
    const searchTerm = escapeRegex(search.trim());
    pipeline.push({ $match: { $or: [
      { username: { $regex: searchTerm, $options: "i" } },
      { global_name: { $regex: searchTerm, $options: "i" } },
      { "bbs_accounts.bbs_name": { $regex: searchTerm, $options: "i" } }
    ] } });
  }

  const projectStage = {
    $project: {
      _id: 1,
      user_id: { $toString: "$_id" },
      discord_id: 1, global_name: 1, username: 1, avatar: 1,
      bbs_id: "$bbs_accounts.bbs_id",
      bbs_name: "$bbs_accounts.bbs_name",
      role: "$bbs_accounts.role",
      is_primary: "$bbs_accounts.is_primary"
    }
  };

  const [accounts, countResult] = await Promise.all([
    db.collection("users").aggregate([
      ...pipeline, projectStage, { $sort: { bbs_name: 1 } }, { $skip: skip }, { $limit: limit }
    ]).toArray(),
    db.collection("users").aggregate([...pipeline, { $count: "total" }]).toArray()
  ]);

  return { accounts, totalCount: countResult[0]?.total || 0 };
};

// Paginated list of ALL bbs accounts (all users), one item per account, for the public player list.
// A user may appear several times, each account with its own guild/role.
// Optional filters: text search, guild, role.
export const getAllAccounts = async (db, { search, guildeId, role, skip = 0, limit = 50 } = {}) => {
  const pipeline = [
    { $match: { "bbs_accounts.0": { $exists: true } } },
    { $unwind: "$bbs_accounts" },
    { $match: { "bbs_accounts.bbs_id": { $ne: null } } }
  ];

  const accountMatch = {};
  if (guildeId) accountMatch["bbs_accounts.guilde_id"] = guildeId;
  if (role) accountMatch["bbs_accounts.role"] = role;
  if (Object.keys(accountMatch).length > 0) pipeline.push({ $match: accountMatch });

  if (search && search.trim()) {
    const searchTerm = escapeRegex(search.trim());
    pipeline.push({ $match: { $or: [
      { username: { $regex: searchTerm, $options: "i" } },
      { global_name: { $regex: searchTerm, $options: "i" } },
      { "bbs_accounts.bbs_name": { $regex: searchTerm, $options: "i" } },
      { "bbs_accounts.bbs_id": { $regex: searchTerm, $options: "i" } }
    ] } });
  }

  const projectStage = {
    $project: {
      _id: 1,
      user_id: { $toString: "$_id" },
      discord_id: 1, global_name: 1, username: 1, avatar: 1,
      is_banned: 1, last_login: 1,
      bbs_id: "$bbs_accounts.bbs_id",
      bbs_name: "$bbs_accounts.bbs_name",
      guilde_id: "$bbs_accounts.guilde_id",
      role: "$bbs_accounts.role",
      is_primary: "$bbs_accounts.is_primary"
    }
  };

  const [accounts, countResult] = await Promise.all([
    db.collection("users").aggregate([
      ...pipeline, projectStage, { $sort: { last_login: -1 } }, { $skip: skip }, { $limit: limit }
    ]).toArray(),
    db.collection("users").aggregate([...pipeline, { $count: "total" }]).toArray()
  ]);

  return { accounts, totalCount: countResult[0]?.total || 0 };
};
