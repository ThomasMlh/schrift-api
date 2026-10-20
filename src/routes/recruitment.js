import express from 'express';
import rateLimit from 'express-rate-limit';
import { ObjectId } from 'mongodb';
import { requireDb, requireAdmin, validateObjectIdParam } from '../middleware/auth.js';
import { sendDiscordMessage } from '../utils/botClient.js';
import { parseDate } from '../services/killerRecords.js';
import { logger } from '../utils/logger.js';
import {
  getRecruitmentSettings, getGuildPlaces, isRecruitmentFull, createTrackingToken, hashTrackingToken, checkWaitlistPlaces,
} from '../services/recruitment.js';
import { upsertPrimaryAccount, deriveMirrorFields, assertBbsIdAvailable } from '../utils/bbsAccounts.js';

const router = express.Router();

const sendServerError = (res, err) => {
  logger.error('[recruitment]', err);
  res.status(500).json({ success: false, message: 'Erreur serveur' });
};

router.use(requireDb);

const STATUSES = ['new', 'waitlist', 'accepted', 'rejected'];
const LIMITS = { bbs_name: 40, bbs_id: 40, discord: 60, message: 1000, welcome: 1500 };

const applicationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de candidatures envoyées, réessaie plus tard' },
});

const trackingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Trop de requêtes, réessaie plus tard' },
});

// Most recent cycle that already has scores: its guild averages describe the current level
const getReferenceCycle = async (db) => {
  const cycles = await db.collection('cycles').find({}, { projection: { name: 1, year: 1, rotations: 1 } }).toArray();
  const sorted = cycles.sort((a, b) => parseDate(b.rotations?.[0]?.start_date) - parseDate(a.rotations?.[0]?.start_date));
  for (const cycle of sorted) {
    if (await db.collection('scores').countDocuments({ cycle_id: cycle._id.toString() }, { limit: 1 })) return cycle;
  }
  return null;
};

// GET public recruitment page: settings and the active guilds with their size and level
router.get('/', async (req, res) => {
  try {
    const settings = await getRecruitmentSettings(req.db);
    const guilds = await getGuildPlaces(req.db, settings.guild_capacity);
    const guildIds = guilds.map((g) => g._id);

    const cycle = await getReferenceCycle(req.db);
    const averageRows = cycle
      ? await req.db.collection('scores').aggregate([
        { $match: { cycle_id: cycle._id.toString(), guild_id: { $in: guildIds } } },
        { $group: { _id: '$guild_id', average: { $avg: '$score' } } },
      ]).toArray()
      : [];
    const averages = new Map(averageRows.map((r) => [r._id, Math.round(r.average)]));

    res.json({
      success: true,
      is_open: settings.is_open,
      intro: settings.intro,
      guild_capacity: settings.guild_capacity,
      is_full: isRecruitmentFull(guilds),
      reference_cycle: cycle ? { name: cycle.name, year: cycle.year } : null,
      guilds: guilds
        .map((g) => ({
          _id: g._id,
          name: g.name,
          members: g.members,
          free_places: g.free_places,
          average_score: averages.get(g._id) ?? null,
        }))
        .sort((a, b) => (b.average_score ?? 0) - (a.average_score ?? 0)),
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

const cleanText = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// POST a public application, posted to the leaders' channel
router.post('/applications', applicationLimiter, async (req, res) => {
  try {
    // Honeypot: hidden field only bots fill in. Pretend it worked.
    if (req.body?.website) return res.status(201).json({ success: true });

    const settings = await getRecruitmentSettings(req.db);
    if (!settings.is_open) {
      return res.status(403).json({ success: false, message: 'Le recrutement est fermé pour le moment' });
    }

    const bbsName = cleanText(req.body?.bbs_name, LIMITS.bbs_name);
    const discord = cleanText(req.body?.discord, LIMITS.discord);
    if (!bbsName || !discord) {
      return res.status(400).json({ success: false, message: 'Pseudo BBS et pseudo Discord requis' });
    }
    const averageScore = Number(req.body?.average_score);
    const preferredGuildId = ObjectId.isValid(req.body?.preferred_guild_id) ? String(req.body.preferred_guild_id) : null;
    const preferredGuild = preferredGuildId
      ? await req.db.collection('guildes').findOne({ _id: new ObjectId(preferredGuildId), disabled: { $ne: true } }, { projection: { name: 1 } })
      : null;

    // Every guild full: the application joins the waiting list
    const waitlisted = isRecruitmentFull(await getGuildPlaces(req.db, settings.guild_capacity));
    const tracking = createTrackingToken();
    const application = {
      bbs_name: bbsName,
      bbs_id: cleanText(req.body?.bbs_id, LIMITS.bbs_id) || null,
      discord,
      average_score: Number.isFinite(averageScore) && averageScore > 0 ? Math.round(averageScore) : null,
      preferred_guild_id: preferredGuild ? preferredGuildId : null,
      preferred_guild_name: preferredGuild?.name ?? null,
      message: cleanText(req.body?.message, LIMITS.message) || null,
      status: waitlisted ? 'waitlist' : 'new',
      tracking_hash: tracking.hash,
      created_at: new Date(),
    };
    const { insertedId } = await req.db.collection('applications').insertOne(application);

    const channelId = process.env.DISCORD_CHANNEL_GLOBAL_CHEF;
    if (channelId) {
      const lines = [
        `📨 **Nouvelle candidature${waitlisted ? ' (liste d\'attente)' : ''}** : ${application.bbs_name}${application.bbs_id ? ` (ID ${application.bbs_id})` : ''}`,
        `Discord : ${application.discord}`,
        application.average_score ? `Moyenne annoncée : ${application.average_score.toLocaleString('en-US')}` : null,
        application.preferred_guild_name ? `Guilde souhaitée : ${application.preferred_guild_name}` : null,
        application.message ? `> ${application.message.replace(/\n/g, '\n> ')}` : null,
      ].filter(Boolean);
      sendDiscordMessage({ channel_id: channelId, content: lines.join('\n') })
        .catch((err) => logger.error('[recruitment] Notification Discord échouée (non bloquant):', err.message));
    }

    res.status(201).json({ success: true, _id: insertedId.toString(), status: application.status, tracking_token: tracking.token });
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET an application's progress, for the candidate holding its tracking link
router.get('/track/:token', trackingLimiter, async (req, res) => {
  try {
    const application = await req.db.collection('applications').findOne({ tracking_hash: hashTrackingToken(req.params.token) });
    if (!application) return res.status(404).json({ success: false, message: 'Candidature introuvable' });

    const waitlistPosition = application.status === 'waitlist'
      ? await req.db.collection('applications').countDocuments({ status: 'waitlist', created_at: { $lt: application.created_at } }) + 1
      : null;
    res.json({
      success: true,
      application: {
        bbs_name: application.bbs_name,
        status: application.status,
        created_at: application.created_at,
        reviewed_at: application.reviewed_at ?? null,
        preferred_guild_name: application.preferred_guild_name,
        guild_name: application.accepted_guild_name ?? null,
        waitlist_position: waitlistPosition,
      },
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET applications (admin), most recent first
router.get('/applications', requireAdmin, async (req, res) => {
  try {
    const filter = STATUSES.includes(req.query.status) ? { status: req.query.status } : {};
    const applications = await req.db.collection('applications')
      .find(filter, { projection: { tracking_hash: 0 } })
      .sort({ created_at: -1 })
      .limit(200)
      .toArray();
    res.json({ success: true, applications });
  } catch (err) {
    sendServerError(res, err);
  }
});

// PATCH an application's status (admin)
router.patch('/applications/:id', requireAdmin, validateObjectIdParam('id'), async (req, res) => {
  try {
    const { status } = req.body;
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ success: false, message: `status doit être ${STATUSES.join(', ')}` });
    }
    const result = await req.db.collection('applications').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status, reviewed_at: new Date(), reviewed_by: req.user.discord_id || null } }
    );
    if (result.matchedCount === 0) return res.status(404).json({ success: false, message: 'Candidature introuvable' });
    res.json({ success: true, status });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST accept an application (admin): joins a guild, optionally creates the player's profile and
// posts a welcome message in the guild's members channel
router.post('/applications/:id/accept', requireAdmin, validateObjectIdParam('id'), async (req, res) => {
  try {
    const application = await req.db.collection('applications').findOne({ _id: new ObjectId(req.params.id) });
    if (!application) return res.status(404).json({ success: false, message: 'Candidature introuvable' });

    const guildId = ObjectId.isValid(req.body?.guild_id) ? String(req.body.guild_id) : null;
    const guild = guildId
      ? await req.db.collection('guildes').findOne({ _id: new ObjectId(guildId), disabled: { $ne: true } })
      : null;
    if (!guild) return res.status(400).json({ success: false, message: 'Guilde invalide' });

    const result = { player: null, welcome: null };

    if (req.body?.create_player) {
      const bbsId = cleanText(req.body.bbs_id ?? application.bbs_id, LIMITS.bbs_id);
      if (!bbsId) {
        return res.status(400).json({ success: false, message: 'Un ID BBS est requis pour créer la fiche du joueur' });
      }
      await assertBbsIdAvailable(req.db, bbsId);
      const bbsAccounts = upsertPrimaryAccount([], { bbsId, bbsName: application.bbs_name, guildeId: guildId, role: 'membre' });
      const { insertedId } = await req.db.collection('users').insertOne({
        discord_id: null, username: null, global_name: null, discriminator: null, avatar: null, banner: null,
        bbs_accounts: bbsAccounts, ...deriveMirrorFields(bbsAccounts),
        is_admin: false, is_authorized: false, is_banned: false, last_login: null,
        created_via: 'recruitment', created_at: new Date(),
      });
      result.player = { user_id: insertedId.toString(), bbs_id: bbsId };
    }

    const welcome = cleanText(req.body?.welcome_message, LIMITS.welcome);
    if (welcome) {
      if (!guild.discord_general_channel_id) {
        result.welcome = 'no_channel';
      } else {
        try {
          await sendDiscordMessage({ channel_id: guild.discord_general_channel_id, content: welcome });
          result.welcome = 'sent';
        } catch (err) {
          logger.error('[recruitment] Message de bienvenue non envoyé:', err.message);
          result.welcome = 'failed';
        }
      }
    }

    await req.db.collection('applications').updateOne({ _id: application._id }, {
      $set: {
        status: 'accepted',
        accepted_guild_id: guildId,
        accepted_guild_name: guild.name,
        ...(result.player && { user_id: result.player.user_id }),
        reviewed_at: new Date(),
        reviewed_by: req.user.discord_id || null,
      },
    });
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ success: false, message: err.message });
    sendServerError(res, err);
  }
});

// DELETE an application (admin)
router.delete('/applications/:id', requireAdmin, validateObjectIdParam('id'), async (req, res) => {
  try {
    await req.db.collection('applications').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET / PUT recruitment settings (admin)
router.get('/settings', requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, ...(await getRecruitmentSettings(req.db)) });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.put('/settings', requireAdmin, async (req, res) => {
  try {
    const capacity = parseInt(req.body.guild_capacity, 10);
    if (isNaN(capacity) || capacity < 1 || capacity > 200) {
      return res.status(400).json({ success: false, message: 'guild_capacity doit être un entier entre 1 et 200' });
    }
    const settings = {
      is_open: req.body.is_open !== false,
      guild_capacity: capacity,
      intro: cleanText(req.body.intro, 2000),
    };
    await req.db.collection('app_settings').updateOne({ _id: 'recruitment' }, { $set: settings }, { upsert: true });
    await checkWaitlistPlaces(req.db);
    res.json({ success: true, ...settings });
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;
