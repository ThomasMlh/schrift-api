import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin } from '../../middleware/auth.js';
import { getUserDisplayName } from '../../utils/nameMatching.js';
import { notifyDiscord } from '../../utils/notifyDiscord.js';
import { findAccount, upsertPrimaryAccount, updateAccount, deriveMirrorFields } from '../../utils/bbsAccounts.js';
import { logger } from '../../utils/logger.js';
import { sendStatusCodeError } from '../../utils/httpErrors.js';

const router = express.Router();

// POST run a draft: remove then reassign players in bulk
router.post('/draft', requireAdmin, async (req, res) => {
  try {
    const { moves } = req.body;

    if (!Array.isArray(moves) || moves.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Un tableau de mouvements est requis'
      });
    }

    for (const move of moves) {
      if (!move.userId) {
        return res.status(400).json({
          success: false,
          message: 'Chaque mouvement doit contenir userId'
        });
      }
      if (!ObjectId.isValid(move.userId)) {
        return res.status(400).json({
          success: false,
          message: `ID utilisateur invalide: ${move.userId}`
        });
      }
      if (move.toGuildId && !ObjectId.isValid(move.toGuildId)) {
        return res.status(400).json({
          success: false,
          message: `ID guilde invalide: ${move.toGuildId}`
        });
      }
    }

    // Every target guild must exist (removals excluded)
    const targetGuildIds = [...new Set(moves.filter(m => m.toGuildId).map(m => m.toGuildId))];
    let guilds = [];
    if (targetGuildIds.length > 0) {
      guilds = await req.db.collection('guildes').find({
        _id: { $in: targetGuildIds.map(id => new ObjectId(id)) }
      }).toArray();

      if (guilds.length !== targetGuildIds.length) {
        return res.status(400).json({
          success: false,
          message: 'Une ou plusieurs guildes cibles n\'existent pas'
        });
      }
    }

    const userIds = moves.map(m => m.userId);
    const users = await req.db.collection('users').find({
      _id: { $in: userIds.map(id => new ObjectId(id)) }
    }).toArray();

    if (users.length !== userIds.length) {
      return res.status(400).json({
        success: false,
        message: 'Un ou plusieurs utilisateurs n\'existent pas'
      });
    }
    const userMap = new Map(users.map(u => [u._id.toString(), u]));

    // Resolve each move's bbs account (bbsId when given, otherwise the main account) and remember its
    // original guild/role for rollback and notifications.
    const resolvedMoves = [];
    for (const move of moves) {
      const user = userMap.get(move.userId);
      const account = move.bbsId
        ? findAccount(user, move.bbsId)
        : (user.bbs_accounts || []).find(a => a.is_primary) || null;

      if (move.bbsId && !account) {
        return res.status(400).json({ success: false, message: `Compte bbs ${move.bbsId} introuvable pour ${move.userId}` });
      }

      resolvedMoves.push({
        ...move,
        bbsId: account?.bbs_id || null,
        originalGuildeId: account?.guilde_id || null,
        originalRole: account?.role || null,
        originalJoinedAt: account?.guild_joined_at || null,
        bbsName: account?.bbs_name || null
      });
    }

    // Step 1: remove each account from its guild
    for (const move of resolvedMoves) {
      const user = userMap.get(move.userId);
      const bbsAccounts = move.bbsId
        ? updateAccount(user.bbs_accounts, move.bbsId, { guildeId: null, role: null })
        : upsertPrimaryAccount(user.bbs_accounts, { guildeId: null, role: null });
      user.bbs_accounts = bbsAccounts;
      await req.db.collection('users').updateOne(
        { _id: user._id },
        { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
      );
    }

    // Step 2: final headcount per guild (accounts, not users) to enforce the 20-member limit
    const guildCounts = {};
    for (const guildId of targetGuildIds) {
      const rows = await req.db.collection('users').aggregate([
        { $match: { "bbs_accounts.guilde_id": guildId } },
        { $unwind: "$bbs_accounts" },
        { $match: { "bbs_accounts.guilde_id": guildId } },
        { $count: "count" }
      ]).toArray();
      guildCounts[guildId] = rows[0]?.count || 0;
    }

    for (const move of resolvedMoves) {
      if (!move.toGuildId) continue;
      guildCounts[move.toGuildId] = (guildCounts[move.toGuildId] || 0) + 1;
      if (guildCounts[move.toGuildId] > 20) {
        // Rollback: put every account back in its original guild/role
        for (const m of resolvedMoves) {
          if (!m.bbsId || !m.originalGuildeId) continue;
          const user = userMap.get(m.userId);
          const bbsAccounts = updateAccount(user.bbs_accounts, m.bbsId, {
            guildeId: m.originalGuildeId, role: m.originalRole, guildJoinedAt: m.originalJoinedAt
          });
          user.bbs_accounts = bbsAccounts;
          await req.db.collection('users').updateOne(
            { _id: user._id },
            { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
          );
        }
        const guildName = guilds.find(g => g._id.toString() === move.toGuildId)?.name || move.toGuildId;
        return res.status(400).json({
          success: false,
          message: `La guilde ${guildName} dépasserait la limite de 20 membres`
        });
      }
    }

    // Step 3: assign each account to its new guild (or leave it guildless)
    const results = [];
    for (const move of resolvedMoves) {
      const user = userMap.get(move.userId);
      if (move.toGuildId) {
        const role = move.role || 'membre';
        const bbsAccounts = move.bbsId
          ? updateAccount(user.bbs_accounts, move.bbsId, { guildeId: move.toGuildId, role })
          : upsertPrimaryAccount(user.bbs_accounts, { guildeId: move.toGuildId, role });
        user.bbs_accounts = bbsAccounts;
        await req.db.collection('users').updateOne(
          { _id: user._id },
          { $set: { bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts) } }
        );
      }
      // A null toGuildId leaves the account guildless (already removed in step 1)
      results.push({
        userId: move.userId,
        username: move.bbsName || getUserDisplayName(user),
        toGuildId: move.toGuildId || null,
        toGuildName: move.toGuildId
          ? (guilds.find(g => g._id.toString() === move.toGuildId)?.name || 'Inconnue')
          : 'Aucune guilde'
      });
    }

    // Discord notifications per affected guild, awaited before responding.
    try {
      // Source guilds (`guilds` only holds the targets)
      const sourceGuildeIds = [...new Set(resolvedMoves.map(m => m.originalGuildeId).filter(Boolean))];
      const missingIds = sourceGuildeIds.filter(id => !guilds.find(g => g._id.toString() === id));
      const allGuildes = [...guilds];
      if (missingIds.length > 0) {
        const sourceGuildes = await req.db.collection('guildes').find({
          _id: { $in: missingIds.map(id => new ObjectId(id)) }
        }).toArray();
        allGuildes.push(...sourceGuildes);
      }

      const guildeMap = {};
      for (const g of allGuildes) {
        guildeMap[g._id.toString()] = { name: g.name, discord_channel_id: g.discord_channel_id, moves: [] };
      }

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const move = resolvedMoves[i];
        const fromGuildeId = move.originalGuildeId;
        const toGuildeId = result.toGuildId;

        const fromGuildName = fromGuildeId ? (guildeMap[fromGuildeId]?.name || 'Guilde inconnue') : 'Aucune guilde';
        const toGuildName = toGuildeId ? (guildeMap[toGuildeId]?.name || 'Guilde inconnue') : 'Aucune guilde';

        if (fromGuildeId && guildeMap[fromGuildeId]) {
          guildeMap[fromGuildeId].moves.push({
            username: result.username,
            fromGuildName,
            toGuildName,
            direction: 'départ',
          });
        }
        if (toGuildeId && guildeMap[toGuildeId]) {
          guildeMap[toGuildeId].moves.push({
            username: result.username,
            fromGuildName,
            toGuildName,
            direction: 'arrivée',
          });
        }
      }

      await Promise.allSettled(
        Object.values(guildeMap)
          .filter(g => g.moves.length > 0)
          .map(g => notifyDiscord('draft', { guild_name: g.name, moves: g.moves }, g.discord_channel_id || undefined))
      );
    } catch (notifErr) {
      logger.error('[draft] Erreur lors des notifications Discord:', notifErr.message);
    }

    res.json({
      success: true,
      message: `${moves.length} joueur(s) déplacé(s) avec succès`,
      results
    });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur serveur lors du draft', 'Erreur lors de l\'exécution du draft:');
  }
});

export default router;
