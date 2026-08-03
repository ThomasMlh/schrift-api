import { ObjectId } from "mongodb";
import { escapeRegex } from "./regexUtils.js";

// Utilitaires pour gérer les comptes bbs multiples (principal + alts) d'un user.
// bbs_accounts: [{ bbs_id, bbs_name, guilde_id, role, is_primary, linked_at }]

// Retrouve le compte bbs_accounts d'un user correspondant à un bbs_id donné.
export const findAccount = (user, bbsId) =>
  (user?.bbs_accounts || []).find(a => a.bbs_id === bbsId) || null;

// Le compte principal d'un user (is_primary, ou le premier par défaut).
export const getPrimaryAccount = (bbsAccounts) =>
  (bbsAccounts || []).find(a => a.is_primary) || (bbsAccounts || [])[0] || null;

// Champs racine bbs_id/bbs_name/guilde_id/role : miroir en lecture seule du compte principal,
// conservés pour ne pas casser les projections/recherches existantes qui les lisent directement.
export const deriveMirrorFields = (bbsAccounts) => {
  const primary = getPrimaryAccount(bbsAccounts);
  return {
    bbs_id: primary?.bbs_id || null,
    bbs_name: primary?.bbs_name || null,
    guilde_id: primary?.guilde_id || null,
    role: primary?.role || null
  };
};

// Grants chef/sous-chef à embarquer dans le JWT : un par compte ayant un rôle élevé,
// scopé à la guilde de CE compte (pas de fusion vers un seul couple role/guilde_id).
export const buildGuildRoles = (bbsAccounts) =>
  (bbsAccounts || [])
    .filter(a => a.role === "chef" || a.role === "sous-chef")
    .map(a => ({ bbs_id: a.bbs_id, guilde_id: a.guilde_id, role: a.role }));

// Construit/actualise le compte bbs PRINCIPAL d'un user (is_primary: true). Le principal peut exister
// avant même d'avoir un bbs_id (ex: rattaché à une guilde/rôle en attendant la liaison du compte de jeu) —
// on retrouve donc l'entrée par is_primary en priorité, et par bbs_id seulement en repli.
export const upsertPrimaryAccount = (existingAccounts, { bbsId, bbsName, guildeId, role }) => {
  const accounts = [...(existingAccounts || [])];
  const hasData = bbsId || bbsName || guildeId || role;

  let index = accounts.findIndex(a => a.is_primary);
  if (index === -1 && bbsId) {
    index = accounts.findIndex(a => a.bbs_id === bbsId);
  }

  if (index === -1) {
    if (!hasData) return accounts; // rien à créer
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

// Ajoute un nouveau compte alt (non principal par défaut). Erreur si ce bbs_id est déjà rattaché à cet user.
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

// Modifie bbs_name/guilde_id/role d'un compte existant (retrouvé par bbs_id).
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

// Renomme l'identifiant bbs_id d'un compte existant (ex: faute de frappe à la création). Ne touche
// que le tableau bbs_accounts — les scores déjà saisis sous l'ancien bbs_id sont migrés séparément
// par l'appelant (cf. route), pour que l'historique reste rattaché au bon compte.
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

// Vérifie qu'aucun AUTRE user n'a déjà un compte avec ce bbs_id — un bbs_id identifie un seul
// compte de jeu, jamais partagé entre deux users Discord différents.
export const assertBbsIdAvailable = async (db, bbsId, excludeUserId) => {
  const conflict = await db.collection("users").findOne({
    "bbs_accounts.bbs_id": bbsId,
    ...(excludeUserId ? { _id: { $ne: new ObjectId(excludeUserId) } } : {})
  });
  if (conflict) {
    throw Object.assign(new Error("Ce bbs_id est déjà rattaché à un autre utilisateur"), { statusCode: 400 });
  }
};

// Retire un compte. Le compte principal ne peut être retiré que s'il ne reste plus d'autre compte
// (sinon il faut d'abord désigner un autre compte comme principal via setPrimaryAccount).
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

// Change le compte principal (bascule le miroir racine bbs_id/bbs_name/guilde_id/role).
export const setPrimaryAccount = (existingAccounts, bbsId) => {
  const accounts = [...(existingAccounts || [])];
  const index = accounts.findIndex(a => a.bbs_id === bbsId);
  if (index === -1) {
    throw Object.assign(new Error("Compte bbs introuvable pour cet utilisateur"), { statusCode: 404 });
  }
  return accounts.map((a, i) => ({ ...a, is_primary: i === index }));
};

// Compte combien de comptes bbs (tous users confondus) ont un rôle donné dans une guilde,
// en excluant éventuellement un compte précis (celui qu'on est en train de modifier).
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

// Vérifie la contrainte "1 chef / 2 sous-chefs max par guilde" au niveau des comptes
// (et non plus des users) ; lève une erreur { statusCode: 400 } si la contrainte est violée.
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

// Vérifie que chaque bbs_id soumis (scores: [{user_id, bbs_id, guild_id}]) appartient bien au
// user_id ciblé, et que le compte est rattaché à la guilde du score soumis (empêche un chef de
// guilde A de saisir un score pour un compte alt rattaché à la guilde B via un guild_id erroné).
// Retourne une Map `${user_id}-${bbs_id}` -> compte, utilisée pour dénormaliser bbs_name sur le
// score à partir de la source de vérité en DB plutôt que d'une valeur envoyée par le client.
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

// Roster des comptes bbs rattachés à une guilde donnée (un élément par compte, potentiellement
// plusieurs par user s'il a plusieurs comptes dans la même guilde). Chaque ligne porte de quoi
// identifier le user propriétaire (avatar/global_name/discord_id) ET le compte précis (bbs_id/bbs_name).
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

// Comptes bbs (tous users confondus) sans guilde — un élément par compte, pas par user : un user
// dont le compte principal est en guilde mais un alt sans guilde verra cet alt listé ici.
// Retourne { accounts, totalCount } pour pagination (search, skip, limit optionnels).
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

// Liste paginée de TOUS les comptes bbs (tous users confondus), un élément par compte — pour la
// liste publique des joueurs. Un même user peut apparaître plusieurs fois (une ligne par compte),
// chacune avec sa propre guilde/rôle. Filtres optionnels : recherche texte, guilde, rôle.
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
