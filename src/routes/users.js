import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb, requireAdmin, validateObjectIdParam } from '../middleware/auth.js';
import { notifyDiscord } from '../utils/notifyDiscord.js';
import { getUserStats } from '../services/userStats.js';
import { getUserDisplayName } from '../utils/nameMatching.js';
import { parsePaginationParams, buildPaginationMeta } from '../utils/pagination.js';
import { USER_FULL, USER_DISPLAY } from '../utils/projections.js';
import { escapeRegex } from '../utils/regexUtils.js';
import {
  upsertPrimaryAccount, deriveMirrorFields, findAccount, assertRoleAvailable,
  addAltAccount, updateAccount, removeAccount, setPrimaryAccount, getAccountsWithoutGuild,
  getAllAccounts, renameAccountBbsId, assertBbsIdAvailable
} from '../utils/bbsAccounts.js';
import players from '../assets/joueurs.json' with { type: "json" };
import { logger } from '../utils/logger.js';
import { sendHiddenServiceError } from '../utils/httpErrors.js';

const router = express.Router();

const notifyGuildChange = async (db, userBefore, newGuildeId) => {
  const username = getUserDisplayName(userBefore);
  const oldGuildeId = userBefore.guilde_id || null;

  const [oldGuilde, newGuilde] = await Promise.all([
    oldGuildeId ? db.collection('guildes').findOne({ _id: new ObjectId(oldGuildeId) }) : null,
    newGuildeId ? db.collection('guildes').findOne({ _id: new ObjectId(newGuildeId) }) : null,
  ]);

  const oldGuildName = oldGuilde?.name || 'Aucune guilde';
  const newGuildName = newGuilde?.name || 'Aucune guilde';

  const promises = [];

  if (oldGuilde) {
    promises.push(notifyDiscord('draft', {
      guild_name: oldGuildName,
      moves: [{ username, fromGuildName: oldGuildName, toGuildName: newGuildName, direction: 'départ' }],
    }, oldGuilde.discord_channel_id || undefined));
  }

  if (newGuilde) {
    promises.push(notifyDiscord('draft', {
      guild_name: newGuildName,
      moves: [{ username, fromGuildName: oldGuildName, toGuildName: newGuildName, direction: 'arrivée' }],
    }, newGuilde.discord_channel_id || undefined));
  }

  await Promise.allSettled(promises);
};

// Notifie un join/leave de guilde pour UN compte bbs précis (utilisé par les routes /accounts/*,
// qui portent la vraie logique d'édition guilde/rôle depuis EditUserModal — contrairement aux
// routes legacy /role et /guild ci-dessous qui ne ciblent que le compte principal).
const notifyAccountGuildMove = async (db, { username, oldGuildeId, newGuildeId, role }) => {
  const [oldGuilde, newGuilde] = await Promise.all([
    oldGuildeId ? db.collection('guildes').findOne({ _id: new ObjectId(oldGuildeId) }) : null,
    newGuildeId ? db.collection('guildes').findOne({ _id: new ObjectId(newGuildeId) }) : null,
  ]);

  const promises = [];
  if (oldGuilde) {
    promises.push(notifyDiscord('guild_member_change', {
      action: 'leave', username, guild_name: oldGuilde.name
    }, oldGuilde.discord_channel_id || process.env.DISCORD_CHANNEL_GLOBAL_CHEF));
  }
  if (newGuilde) {
    promises.push(notifyDiscord('guild_member_change', {
      action: 'join', username, guild_name: newGuilde.name, role
    }, newGuilde.discord_channel_id || process.env.DISCORD_CHANNEL_GLOBAL_CHEF));
  }
  await Promise.allSettled(promises);
};

// Notifie un changement de rôle pour UN compte bbs précis (guilde inchangée).
const notifyAccountRoleChange = async (db, { username, guildeId, oldRole, newRole }) => {
  const guilde = guildeId ? await db.collection('guildes').findOne({ _id: new ObjectId(guildeId) }) : null;
  await notifyDiscord('membre_role_change', {
    membre_name: username,
    guild_name: guilde?.name || '',
    old_role: oldRole || 'membre',
    new_role: newRole
  }, guilde?.discord_channel_id || process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
};

// Middleware pour toutes les routes users
router.use(requireDb);

// Route pour créer un utilisateur "placeholder" (ex: arrivée sur le serveur Discord), appelée par le bot.
// Idempotente : si le discord_id existe déjà, ne fait rien et renvoie l'utilisateur existant.
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { discord_id, username, global_name, avatar, banner, discriminator } = req.body;

    if (!discord_id) {
      return res.status(400).json({ success: false, message: 'discord_id requis' });
    }

    const discordId = String(discord_id);

    const existingUser = await req.db.collection('users').findOne({ discord_id: discordId });
    if (existingUser) {
      return res.json({ success: true, created: false, message: 'Utilisateur déjà existant', user: existingUser });
    }

    // Tentative de rattachement à un joueur/guilde connus (même logique que le login Discord)
    let playerInfo = null;
    if (players.joueurs && Array.isArray(players.joueurs)) {
      playerInfo = players.joueurs.find(p => p.id_discord === discordId);
    }

    let guildeInfo = null;
    if (playerInfo && playerInfo.guilde) {
      const extractGuildName = playerInfo.guilde.split(' ')[1];
      guildeInfo = await req.db.collection('guildes').findOne({ name: extractGuildName });
    }

    const bbsAccounts = upsertPrimaryAccount([], {
      bbsId: playerInfo?.id_bbs || null,
      bbsName: playerInfo?.pseudo_bbs || null,
      guildeId: guildeInfo?._id?.toString() || null,
      role: playerInfo?.statut ? playerInfo.statut.toLowerCase() : null
    });
    const mirror = deriveMirrorFields(bbsAccounts);

    const newUser = {
      discord_id: discordId,
      username: username || null,
      global_name: global_name || null,
      discriminator: discriminator || null,
      avatar: avatar || null,
      banner: banner || null,
      bbs_accounts: bbsAccounts,
      bbs_id: mirror.bbs_id,
      bbs_name: mirror.bbs_name,
      guilde_id: mirror.guilde_id,
      role: mirror.role,
      is_admin: false,
      is_authorized: false,
      is_banned: false,
      last_login: new Date(),
      created_via: 'discord_member_join',
      created_at: new Date(),
    };

    const insertResult = await req.db.collection('users').insertOne(newUser);
    const savedUser = await req.db.collection('users').findOne({ _id: insertResult.insertedId });

    res.status(201).json({ success: true, created: true, message: 'Utilisateur créé avec succès', user: savedUser });
  } catch (error) {
    logger.error('Erreur lors de la création de l\'utilisateur:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Route pour créer manuellement un joueur SANS discord_id (admin seulement) : cas rare d'un joueur
// sans compte Discord, à qui on veut quand même pouvoir rattacher un compte bbs et saisir des scores.
router.post('/manual', requireAdmin, async (req, res) => {
  try {
    const { bbs_id, bbs_name, guilde_id, role } = req.body;

    if (!bbs_id) {
      return res.status(400).json({ success: false, message: 'bbs_id requis' });
    }

    await assertBbsIdAvailable(req.db, bbs_id);

    if (role === 'chef' || role === 'sous-chef') {
      await assertRoleAvailable(req.db, guilde_id, role);
    }

    const bbsAccounts = upsertPrimaryAccount([], { bbsId: bbs_id, bbsName: bbs_name, guildeId: guilde_id, role });
    const mirror = deriveMirrorFields(bbsAccounts);

    const newUser = {
      discord_id: null,
      username: null,
      global_name: null,
      discriminator: null,
      avatar: null,
      banner: null,
      bbs_accounts: bbsAccounts,
      bbs_id: mirror.bbs_id,
      bbs_name: mirror.bbs_name,
      guilde_id: mirror.guilde_id,
      role: mirror.role,
      is_admin: false,
      is_authorized: false,
      is_banned: false,
      last_login: null,
      created_via: 'manual_admin',
      created_at: new Date(),
    };

    const insertResult = await req.db.collection('users').insertOne(newUser);
    const savedUser = await req.db.collection('users').findOne({ _id: insertResult.insertedId });

    res.status(201).json({ success: true, message: 'Joueur créé avec succès', user: savedUser });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors de la création manuelle du joueur:');
  }
});

// Route pour récupérer tous les utilisateurs avec pagination (accessible à tous)
router.get('/', async (req, res) => {
  try {
    const { page, limit, skip } = parsePaginationParams(req.query);

    // Paramètres de filtrage optionnels
    const { guilde_id, role, search, is_banned } = req.query;

    // Construire la requête de filtrage
    const query = {};

    // Filtre par statut de bannissement
    if (is_banned === 'true') {
      query.is_banned = true;
    } else if (is_banned === 'false') {
      query.is_banned = { $ne: true };
    }

    // $and accumule les conditions $or indépendantes (guilde/rôle, recherche) : les combiner en
    // écrivant plusieurs fois query.$or les écraserait entre elles (un seul $or par niveau).
    const andConditions = [];

    // Filtre par guilde et/ou rôle — matche soit le compte principal (champs miroir), soit
    // n'importe quel compte bbs (alt compris) ayant CETTE guilde ET CE rôle ensemble ($elemMatch
    // pour corréler les deux conditions sur le même compte, pas deux comptes différents).
    const guildeIdTrim = guilde_id && guilde_id.trim();
    const roleTrim = role && role.trim();
    if (guildeIdTrim || roleTrim) {
      const mirrorMatch = {};
      const accountMatch = {};
      if (guildeIdTrim) { mirrorMatch.guilde_id = guildeIdTrim; accountMatch.guilde_id = guildeIdTrim; }
      if (roleTrim) { mirrorMatch.role = roleTrim; accountMatch.role = roleTrim; }
      andConditions.push({ $or: [mirrorMatch, { bbs_accounts: { $elemMatch: accountMatch } }] });
    }

    // Filtre par recherche textuelle (nom d'utilisateur, nom global, ou n'importe quel compte bbs — alt compris)
    if (search && search.trim()) {
      const searchTerm = escapeRegex(search.trim());
      andConditions.push({
        $or: [
          { username: { $regex: searchTerm, $options: 'i' } },
          { global_name: { $regex: searchTerm, $options: 'i' } },
          { bbs_name: { $regex: searchTerm, $options: 'i' } },
          { discord_id: { $regex: searchTerm, $options: 'i' } },
          { bbs_id: { $regex: searchTerm, $options: 'i' } },
          { 'bbs_accounts.bbs_name': { $regex: searchTerm, $options: 'i' } },
          { 'bbs_accounts.bbs_id': { $regex: searchTerm, $options: 'i' } }
        ]
      });
    }

    if (andConditions.length > 0) {
      query.$and = andConditions;
    }

    const users = await req.db.collection('users')
      .find(query, { projection: USER_FULL })
      .sort({ last_login: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const totalCount = await req.db.collection('users').countDocuments(query);

    res.json({
      success: true,
      users,
      pagination: buildPaginationMeta(page, limit, totalCount, users.length),
      activeFilters: {
        guilde_id: guilde_id || null,
        role: role || null,
        search: search || null
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des utilisateurs:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Route pour récupérer les comptes bbs sans guilde avec pagination (un élément par compte,
// pas par user — un alt sans guilde apparaît même si le compte principal du même user en a une)
router.get('/without-guild', async (req, res) => {
  try {
    const { page, limit, skip } = parsePaginationParams(req.query);
    const { search } = req.query;

    const { accounts, totalCount } = await getAccountsWithoutGuild(req.db, { search, skip, limit });

    res.json({
      success: true,
      users: accounts,
      pagination: buildPaginationMeta(page, limit, totalCount, accounts.length),
      activeFilters: {
        search: search || null
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des comptes sans guilde:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Route pour récupérer la liste des comptes bbs (tous users confondus, un élément par compte) —
// utilisée par la liste publique des joueurs. Un même user peut apparaître plusieurs fois (une
// ligne par compte), chacune avec sa propre guilde/rôle, cohérent avec le classement/rosters.
router.get('/accounts', async (req, res) => {
  try {
    const { page, limit, skip } = parsePaginationParams(req.query);
    const { guilde_id, role, search } = req.query;

    const { accounts, totalCount } = await getAllAccounts(req.db, {
      search,
      guildeId: guilde_id && guilde_id.trim() ? guilde_id.trim() : undefined,
      role: role && role.trim() ? role.trim() : undefined,
      skip,
      limit
    });

    res.json({
      success: true,
      users: accounts,
      pagination: buildPaginationMeta(page, limit, totalCount, accounts.length),
      activeFilters: {
        guilde_id: guilde_id || null,
        role: role || null,
        search: search || null
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des comptes bbs:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Route pour récupérer un utilisateur spécifique
router.get('/:userId', validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await req.db.collection('users').findOne(
      { _id: new ObjectId(userId) },
      { projection: USER_FULL }
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    res.json({ success: true, user });
  } catch (error) {
    logger.error('Erreur lors de la récupération de l\'utilisateur:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

router.patch('/:userId', validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId } = req.params;
    const updates = { ...req.body };

    const userBefore = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!userBefore) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    // bbs_id/bbs_name/guilde_id/role ciblent ici le compte bbs PRINCIPAL (miroir racine) ;
    // la gestion des comptes alt passe par les routes /:userId/accounts/*.
    const touchesPrimaryAccount = ['bbs_id', 'bbs_name', 'guilde_id', 'role'].some(f => f in updates);
    if (touchesPrimaryAccount) {
      const primary = (userBefore.bbs_accounts || []).find(a => a.is_primary) || null;
      const nextRole = 'role' in updates ? updates.role : (primary?.role ?? null);
      const nextGuildeId = 'guilde_id' in updates ? updates.guilde_id : (primary?.guilde_id ?? null);

      if ((nextRole === 'chef' || nextRole === 'sous-chef') &&
          (nextRole !== primary?.role || nextGuildeId !== primary?.guilde_id)) {
        await assertRoleAvailable(req.db, nextGuildeId, nextRole, primary?.bbs_id);
      }

      const bbsAccounts = upsertPrimaryAccount(userBefore.bbs_accounts, {
        bbsId: 'bbs_id' in updates ? updates.bbs_id : primary?.bbs_id,
        bbsName: 'bbs_name' in updates ? updates.bbs_name : primary?.bbs_name,
        guildeId: nextGuildeId,
        role: nextRole
      });

      updates.bbs_accounts = bbsAccounts;
      Object.assign(updates, deriveMirrorFields(bbsAccounts));
    }

    const result = await req.db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      { $set: updates }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    const updatedUser = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });

    // Notification Discord si la guilde a changé — attendue avant la réponse.
    if ('guilde_id' in updates && updates.guilde_id !== userBefore.guilde_id) {
      await notifyGuildChange(req.db, userBefore, updates.guilde_id || null).catch(e =>
        logger.error('[users/patch] Erreur notification Discord:', e.message)
      );
    }

    res.json({ success: true, message: `${getUserDisplayName(updatedUser)} mis à jour avec succès` });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors de la mise à jour de l\'utilisateur:');
  }
});

// Route pour mettre à jour le rôle d'un utilisateur (admin seulement)
// bbs_id optionnel : cible ce compte précis ; par défaut, le compte principal.
router.put('/:userId/role', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { role, bbs_id } = req.body;

    if (!role) {
      return res.status(400).json({ success: false, message: 'Le rôle est requis' });
    }

    // Récupérer l'utilisateur pour connaître sa guilde
    let user;

    // Essayer d'abord comme ObjectId MongoDB, sinon comme discord_id
    if (ObjectId.isValid(userId)) {
      user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    } else {
      user = await req.db.collection('users').findOne({ discord_id: userId });
    }

    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    const targetAccount = bbs_id
      ? findAccount(user, bbs_id)
      : (user.bbs_accounts || []).find(a => a.is_primary) || null;

    if (bbs_id && !targetAccount) {
      return res.status(404).json({ success: false, message: 'Compte bbs introuvable pour cet utilisateur' });
    }

    const guildeId = targetAccount?.guilde_id || null;

    if (!guildeId) {
      return res.status(400).json({
        success: false,
        message: 'Le compte doit être dans une guilde pour avoir un rôle'
      });
    }

    // Vérifier les contraintes de rôle (au niveau des comptes, pas des users)
    await assertRoleAvailable(req.db, guildeId, role, targetAccount?.bbs_id);

    const oldRole = targetAccount?.role || 'membre';

    const bbsAccounts = bbs_id
      ? updateAccount(user.bbs_accounts, bbs_id, { role })
      : upsertPrimaryAccount(user.bbs_accounts, {
          bbsId: targetAccount?.bbs_id, bbsName: targetAccount?.bbs_name, guildeId, role
        });

    const result = await req.db.collection('users').updateOne(
      { _id: user._id },
      { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    // Notification Discord — attendue avant la réponse : sur Vercel (serverless), l'exécution
    // peut être coupée dès la réponse envoyée, donc un appel non attendu après res.json() n'est
    // pas garanti d'aboutir (silencieusement manqué, de façon intermittente).
    if (oldRole !== role) {
      try {
        const guilde = await req.db.collection('guildes').findOne({ _id: new ObjectId(guildeId) });
        await notifyDiscord('membre_role_change', {
          membre_name: targetAccount?.bbs_name || getUserDisplayName(user),
          guild_name: guilde?.name || '',
          old_role: oldRole,
          new_role: role
        }, guilde?.discord_channel_id || process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
      } catch (notifErr) {
        logger.error('[users/role] Erreur notification Discord (non bloquant):', notifErr.message);
      }
    }

    res.json({ success: true, message: `Rôle mis à jour vers ${role}` });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors de la mise à jour du rôle:');
  }
});

// Route pour changer la guilde d'un utilisateur (admin seulement)
// bbs_id optionnel : cible ce compte précis ; par défaut, le compte principal.
router.put('/:userId/guild', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId } = req.params;
    const { guildeId, role, bbs_id } = req.body;

    if (!guildeId) {
      return res.status(400).json({ success: false, message: 'L\'ID de la guilde est requis' });
    }

    const newRole = role || 'membre';

    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    const targetAccount = bbs_id ? findAccount(user, bbs_id) : (user.bbs_accounts || []).find(a => a.is_primary) || null;
    if (bbs_id && !targetAccount) {
      return res.status(404).json({ success: false, message: 'Compte bbs introuvable pour cet utilisateur' });
    }

    // Vérifier les contraintes si un rôle spécifique est demandé (au niveau des comptes, pas des users)
    if (newRole === 'chef' || newRole === 'sous-chef') {
      await assertRoleAvailable(req.db, guildeId, newRole, targetAccount?.bbs_id);
    }

    // Mettre à jour la guilde et le rôle du compte ciblé
    const bbsAccounts = bbs_id
      ? updateAccount(user.bbs_accounts, bbs_id, { guildeId, role: newRole })
      : upsertPrimaryAccount(user.bbs_accounts, {
          bbsId: targetAccount?.bbs_id, bbsName: targetAccount?.bbs_name, guildeId, role: newRole
        });

    await req.db.collection('users').updateOne(
      { _id: user._id },
      { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
    );

    // Notification Discord — uniquement pertinente pour le compte principal (c'est ce que
    // reflètent les champs racine guilde_id/role affichés ailleurs) — attendue avant la réponse.
    if (!bbs_id || targetAccount?.is_primary) {
      await notifyGuildChange(req.db, user, guildeId).catch(e =>
        logger.error('[users/guild] Erreur notification Discord:', e.message)
      );
    }

    res.json({ success: true, message: `${getUserDisplayName(user, 'Utilisateur')} déplacé vers la nouvelle guilde` });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors du changement de guilde:');
  }
});

// --- Gestion des comptes bbs (principal + alts) d'un user ---

// POST ajouter un compte alt à un user (admin seulement)
router.post('/:userId/accounts', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId } = req.params;
    const { bbs_id, bbs_name, guilde_id, role } = req.body;

    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    if (bbs_id) {
      await assertBbsIdAvailable(req.db, bbs_id, userId);
    }

    if ((role === 'chef' || role === 'sous-chef') && guilde_id) {
      await assertRoleAvailable(req.db, guilde_id, role, bbs_id);
    }

    const bbsAccounts = addAltAccount(user.bbs_accounts, { bbsId: bbs_id, bbsName: bbs_name, guildeId: guilde_id, role });

    await req.db.collection('users').updateOne(
      { _id: user._id },
      { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
    );

    // Notification Discord — attendue avant la réponse.
    if (guilde_id) {
      try {
        await notifyAccountGuildMove(req.db, {
          username: bbs_name || getUserDisplayName(user),
          oldGuildeId: null,
          newGuildeId: guilde_id,
          role
        });
      } catch (notifErr) {
        logger.error('[users/accounts POST] Erreur notification Discord (non bloquant):', notifErr.message);
      }
    }

    res.status(201).json({ success: true, message: 'Compte bbs ajouté avec succès', bbs_accounts: bbsAccounts });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors de l\'ajout du compte bbs:');
  }
});

// PUT modifier un compte bbs existant d'un user (admin seulement)
// bbs_id dans le body est optionnel : s'il est fourni et différent du :bbsId de l'URL, le compte
// est renommé (ex: faute de frappe à la création) et l'historique des scores de ce compte migre
// avec lui, pour que le classement/l'historique du joueur restent cohérents après correction.
router.put('/:userId/accounts/:bbsId', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId, bbsId } = req.params;
    const { bbs_id: newBbsId, bbs_name, guilde_id, role } = req.body;

    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    const accountBefore = findAccount(user, bbsId);

    if (role === 'chef' || role === 'sous-chef') {
      const targetGuildeId = guilde_id !== undefined ? guilde_id : accountBefore?.guilde_id;
      await assertRoleAvailable(req.db, targetGuildeId, role, bbsId);
    }

    const isRenaming = !!newBbsId && newBbsId !== bbsId;
    let bbsAccounts = user.bbs_accounts;

    if (isRenaming) {
      await assertBbsIdAvailable(req.db, newBbsId, userId);
      bbsAccounts = renameAccountBbsId(bbsAccounts, bbsId, newBbsId);
    }

    bbsAccounts = updateAccount(bbsAccounts, isRenaming ? newBbsId : bbsId, { bbsName: bbs_name, guildeId: guilde_id, role });

    await req.db.collection('users').updateOne(
      { _id: user._id },
      { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
    );

    // Migrer l'historique des scores de ce compte vers le nouvel identifiant/pseudo
    if (isRenaming || bbs_name !== undefined) {
      const scoreUpdate = {};
      if (isRenaming) scoreUpdate.bbs_id = newBbsId;
      if (bbs_name !== undefined) scoreUpdate.bbs_name = bbs_name;
      await req.db.collection('scores').updateMany(
        { user_id: userId, bbs_id: bbsId },
        { $set: scoreUpdate }
      );
    }

    // Notification Discord — guilde et/ou rôle du compte ont pu changer, attendue avant la réponse.
    try {
      const oldGuildeId = accountBefore?.guilde_id || null;
      const oldRole = accountBefore?.role || null;
      const newGuildeId = guilde_id !== undefined ? (guilde_id || null) : oldGuildeId;
      const newRole = role !== undefined ? role : oldRole;
      const username = (bbs_name !== undefined ? bbs_name : accountBefore?.bbs_name) || getUserDisplayName(user);

      if (newGuildeId !== oldGuildeId) {
        await notifyAccountGuildMove(req.db, { username, oldGuildeId, newGuildeId, role: newRole });
      } else if (newRole !== oldRole) {
        await notifyAccountRoleChange(req.db, { username, guildeId: newGuildeId, oldRole, newRole });
      }
    } catch (notifErr) {
      logger.error('[users/accounts PUT] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.json({ success: true, message: 'Compte bbs mis à jour avec succès', bbs_accounts: bbsAccounts });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors de la mise à jour du compte bbs:');
  }
});

// DELETE retirer un compte bbs d'un user (admin seulement)
router.delete('/:userId/accounts/:bbsId', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId, bbsId } = req.params;

    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    const accountBefore = findAccount(user, bbsId);
    const bbsAccounts = removeAccount(user.bbs_accounts, bbsId);

    await req.db.collection('users').updateOne(
      { _id: user._id },
      { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
    );

    // Notification Discord — attendue avant la réponse.
    if (accountBefore?.guilde_id) {
      try {
        await notifyAccountGuildMove(req.db, {
          username: accountBefore.bbs_name || getUserDisplayName(user),
          oldGuildeId: accountBefore.guilde_id,
          newGuildeId: null
        });
      } catch (notifErr) {
        logger.error('[users/accounts DELETE] Erreur notification Discord (non bloquant):', notifErr.message);
      }
    }

    res.json({ success: true, message: 'Compte bbs retiré avec succès', bbs_accounts: bbsAccounts });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors du retrait du compte bbs:');
  }
});

// PUT définir un compte bbs comme principal (admin seulement)
router.put('/:userId/accounts/:bbsId/primary', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId, bbsId } = req.params;

    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    const bbsAccounts = setPrimaryAccount(user.bbs_accounts, bbsId);

    await req.db.collection('users').updateOne(
      { _id: user._id },
      { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
    );

    res.json({ success: true, message: 'Compte principal mis à jour avec succès', bbs_accounts: bbsAccounts });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors du changement de compte principal:');
  }
});

// POST transférer un compte bbs d'un user vers un autre, en tant qu'alt (jamais principal chez la cible).
// N'affecte volontairement pas les scores existants : ils restent liés au bbs_id (déjà dénormalisé
// sur chaque score) et à l'ancien user_id — l'historique "suit" le compte via bbs_id, pas besoin de
// réécrire scores.user_id (cf. décision produit : peu importe quel user_id porte le score historique).
router.post('/:userId/accounts/:bbsId/transfer', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId, bbsId } = req.params;
    const { target_user_id } = req.body;

    if (!target_user_id || !ObjectId.isValid(target_user_id)) {
      return res.status(400).json({ success: false, message: 'target_user_id valide requis' });
    }
    if (target_user_id === userId) {
      return res.status(400).json({ success: false, message: "L'utilisateur cible doit être différent de l'utilisateur source" });
    }

    const sourceUser = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    if (!sourceUser) {
      return res.status(404).json({ success: false, message: 'Utilisateur source non trouvé' });
    }

    const account = findAccount(sourceUser, bbsId);
    if (!account) {
      return res.status(404).json({ success: false, message: 'Compte bbs introuvable pour cet utilisateur' });
    }

    const targetUser = await req.db.collection('users').findOne({ _id: new ObjectId(target_user_id) });
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'Utilisateur cible non trouvé' });
    }

    // Retirer le compte du user source. S'il était principal et qu'il reste d'autres comptes,
    // en promouvoir un automatiquement pour ne pas laisser le user source sans compte principal.
    let sourceAccounts = sourceUser.bbs_accounts || [];
    if (account.is_primary) {
      const nextPrimary = sourceAccounts.find(a => a.bbs_id !== bbsId);
      if (nextPrimary) {
        sourceAccounts = setPrimaryAccount(sourceAccounts, nextPrimary.bbs_id);
      }
    }
    sourceAccounts = sourceAccounts.filter(a => a.bbs_id !== bbsId);

    // L'ajouter comme alt chez la cible (jamais principal), en conservant bbs_name/guilde/rôle du compte.
    // addAltAccount lève une erreur si ce bbs_id existe déjà chez la cible (ne devrait pas arriver).
    const targetAccounts = addAltAccount(targetUser.bbs_accounts, {
      bbsId: account.bbs_id,
      bbsName: account.bbs_name,
      guildeId: account.guilde_id,
      role: account.role
    });

    await req.db.collection('users').updateOne(
      { _id: sourceUser._id },
      { $set: { bbs_accounts: sourceAccounts, ...deriveMirrorFields(sourceAccounts) } }
    );
    await req.db.collection('users').updateOne(
      { _id: targetUser._id },
      { $set: { bbs_accounts: targetAccounts, ...deriveMirrorFields(targetAccounts) } }
    );

    res.json({
      success: true,
      message: `Compte ${account.bbs_name || bbsId} transféré avec succès`,
      source: { bbs_accounts: sourceAccounts },
      target: { bbs_accounts: targetAccounts }
    });
  } catch (error) {
    sendHiddenServiceError(res, error, 'Erreur lors du transfert de compte:');
  }
});

// GET statistiques personnelles d'un joueur par user_id
router.get('/:user_id/stats', async (req, res) => {
  try {
    const data = await getUserStats(req.db, req.params.user_id, req.query);
    return res.json({ success: true, data });

  } catch (error) {
    return sendHiddenServiceError(res, error, 'Erreur lors de la récupération des statistiques du joueur:', 'Erreur serveur lors de la récupération des statistiques');
  }
});

// Route pour bannir un utilisateur (admin seulement)
router.post('/:userId/ban', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;
    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });

    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    if (user.is_admin) {
      return res.status(403).json({ success: false, message: 'Impossible de bannir un administrateur' });
    }

    if (user.is_banned) {
      return res.status(400).json({ success: false, message: 'Cet utilisateur est déjà banni' });
    }

    await req.db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      {
        $set: {
          is_banned: true,
          ban_reason: reason || null,
          banned_at: new Date(),
          banned_by: req.user.discord_id
        }
      }
    );

    // Notification Discord (non bloquante)
    try {
      const banner = await req.db.collection('users').findOne(
        { _id: new ObjectId(req.user._id) },
        { projection: USER_DISPLAY }
      );
      const bannerName = getUserDisplayName(banner);
      const bannedName = getUserDisplayName(user);
      await notifyDiscord('ban', {
        action: 'ban',
        banned_by: bannerName,
        banned_user: bannedName,
        reason: reason || null,
        banned_at: new Date().toISOString()
      }, process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
    } catch (notifErr) {
      logger.error('[users/ban] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.json({
      success: true,
      message: `${getUserDisplayName(user)} a été banni avec succès`
    });
  } catch (error) {
    logger.error('Erreur lors du bannissement:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Route pour débannir un utilisateur (admin seulement)
router.post('/:userId/unban', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });

    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    if (!user.is_banned) {
      return res.status(400).json({ success: false, message: 'Cet utilisateur n\'est pas banni' });
    }

    await req.db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      {
        $set: {
          is_banned: false,
          ban_reason: null,
          banned_at: null,
          banned_by: null
        }
      }
    );

    // Notification Discord (non bloquante)
    try {
      const unbanner = await req.db.collection('users').findOne(
        { _id: new ObjectId(req.user._id) },
        { projection: USER_DISPLAY }
      );
      const unbannerName = getUserDisplayName(unbanner);
      const unbannedName = getUserDisplayName(user);
      await notifyDiscord('ban', {
        action: 'unban',
        banned_by: unbannerName,
        banned_user: unbannedName,
        reason: null
      }, process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
    } catch (notifErr) {
      logger.error('[users/unban] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.json({
      success: true,
      message: `${getUserDisplayName(user)} a été débanni avec succès`
    });
  } catch (error) {
    logger.error('Erreur lors du débannissement:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

export default router;