import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, validateObjectIdParam } from '../../middleware/auth.js';
import { getUserDisplayName } from '../../utils/nameMatching.js';
import { parsePaginationParams, buildPaginationMeta } from '../../utils/pagination.js';
import { USER_FULL } from '../../utils/projections.js';
import { escapeRegex } from '../../utils/regexUtils.js';
import {
  upsertPrimaryAccount, deriveMirrorFields, assertRoleAvailable, assertBbsIdAvailable,
  getAccountsWithoutGuild, getAllAccounts
} from '../../utils/bbsAccounts.js';
import players from '../../assets/joueurs.json' with { type: "json" };
import { logger } from '../../utils/logger.js';
import { sendHiddenServiceError } from '../../utils/httpErrors.js';
import { notifyGuildChange } from './notifications.js';
import { attachTopAchievements } from '../../services/podiumService/achievementBadges.js';

const router = express.Router();

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
    // Succès le plus rare de chaque compte, affiché à côté du pseudo (comme sur le podium)
    await attachTopAchievements(req.db, accounts);

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

router.patch('/:userId', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
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

export default router;
