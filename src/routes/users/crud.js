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
import { logger } from '../../utils/logger.js';
import { sendHiddenServiceError } from '../../utils/httpErrors.js';
import { notifyGuildChange } from './notifications.js';
import { attachTopAchievements } from '../../services/podiumService/achievementBadges.js';

const router = express.Router();

// POST create a placeholder user (e.g. on joining the Discord server), called by the bot.
// Idempotent: when the discord_id already exists, returns the existing user.
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

    // No bbs account yet: it is linked later from the admin
    const bbsAccounts = [];
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

// POST manually create a player WITHOUT a discord_id (admin only): rare case of a player without a
// Discord account who still needs a bbs account and scores.
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

// GET users with pagination (public)
router.get('/', async (req, res) => {
  try {
    const { page, limit, skip } = parsePaginationParams(req.query);

    const { guilde_id, role, search, is_banned } = req.query;

    const query = {};

    if (is_banned === 'true') {
      query.is_banned = true;
    } else if (is_banned === 'false') {
      query.is_banned = { $ne: true };
    }

    // $and collects the independent $or conditions (guild/role, search): writing query.$or several
    // times would overwrite them (one $or per level).
    const andConditions = [];

    // Guild and/or role filter: matches either the main account (mirror fields) or any bbs account
    // (alts included) holding THIS guild AND THIS role ($elemMatch ties both conditions to the same
    // account).
    const guildeIdTrim = guilde_id && guilde_id.trim();
    const roleTrim = role && role.trim();
    if (guildeIdTrim || roleTrim) {
      const mirrorMatch = {};
      const accountMatch = {};
      if (guildeIdTrim) { mirrorMatch.guilde_id = guildeIdTrim; accountMatch.guilde_id = guildeIdTrim; }
      if (roleTrim) { mirrorMatch.role = roleTrim; accountMatch.role = roleTrim; }
      andConditions.push({ $or: [mirrorMatch, { bbs_accounts: { $elemMatch: accountMatch } }] });
    }

    // Text search on username, global name or any bbs account (alts included)
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

// GET guildless bbs accounts with pagination (one item per account, not per user: a guildless alt
// is listed even when the same user's main account has a guild)
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

// GET every bbs account (all users, one item per account), used by the public player list. A user
// may appear several times, each account with its own guild/role, consistent with rankings/rosters.
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
    // Rarest achievement of each account, shown next to the name (as on the podium)
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

// GET a user by id
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

    // bbs_id/bbs_name/guilde_id/role target the MAIN bbs account (root mirror) here; alt accounts are
    // managed through the /:userId/accounts/* routes.
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

    // Discord notification when the guild changed, awaited before responding.
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
