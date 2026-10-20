import crypto from 'crypto';
import { sendDiscordMessage } from '../utils/botClient.js';
import { logger } from '../utils/logger.js';

// In-game guild size; editable from the admin in case it changes
export const DEFAULT_GUILD_CAPACITY = 30;

export const getRecruitmentSettings = async (db) => {
  const settings = await db.collection('app_settings').findOne({ _id: 'recruitment' });
  return {
    is_open: settings?.is_open ?? true,
    guild_capacity: typeof settings?.guild_capacity === 'number' ? settings.guild_capacity : DEFAULT_GUILD_CAPACITY,
    intro: settings?.intro ?? '',
  };
};

// Active guilds with their member count (one bbs account = one roster place) and free places
export const getGuildPlaces = async (db, capacity) => {
  const guilds = await db.collection('guildes')
    .find({ disabled: { $ne: true } }, { projection: { name: 1, discord_channel_id: 1, discord_general_channel_id: 1 } })
    .toArray();
  const guildIds = guilds.map((g) => g._id.toString());
  const rows = await db.collection('users').aggregate([
    { $match: { 'bbs_accounts.guilde_id': { $in: guildIds } } },
    { $unwind: '$bbs_accounts' },
    { $match: { 'bbs_accounts.guilde_id': { $in: guildIds } } },
    { $group: { _id: '$bbs_accounts.guilde_id', count: { $sum: 1 } } },
  ]).toArray();
  const members = new Map(rows.map((r) => [r._id, r.count]));
  return guilds.map((g) => {
    const id = g._id.toString();
    const count = members.get(id) || 0;
    return { ...g, _id: id, members: count, free_places: Math.max(0, capacity - count) };
  });
};

// Every guild is full: new applications go to the waiting list
export const isRecruitmentFull = (guilds) => guilds.length > 0 && guilds.every((g) => g.free_places === 0);

export const createTrackingToken = () => {
  const token = crypto.randomBytes(18).toString('base64url');
  return { token, hash: hashTrackingToken(token) };
};

export const hashTrackingToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const siteUrl = (path) => (process.env.FRONTEND_URL ? `${process.env.FRONTEND_URL.replace(/\/$/, '')}${path}` : null);

/**
 * Warns the leaders once when a place frees up while candidates are waiting, then re-arms when the
 * guilds are full again. Called after every roster change; never throws.
 */
export const checkWaitlistPlaces = async (db) => {
  try {
    const settings = await db.collection('app_settings').findOne({ _id: 'recruitment' });
    const capacity = typeof settings?.guild_capacity === 'number' ? settings.guild_capacity : DEFAULT_GUILD_CAPACITY;
    const guilds = await getGuildPlaces(db, capacity);
    const open = guilds.filter((g) => g.free_places > 0);

    if (open.length === 0) {
      if (settings?.waitlist_alert_sent) {
        await db.collection('app_settings').updateOne({ _id: 'recruitment' }, { $set: { waitlist_alert_sent: false } });
      }
      return { alerted: false };
    }
    if (settings?.waitlist_alert_sent) return { alerted: false };

    const waiting = await db.collection('applications').countDocuments({ status: 'waitlist' });
    if (waiting === 0) return { alerted: false };

    // Claim the alert before sending, so two concurrent roster changes do not both post it
    const claimed = await db.collection('app_settings').updateOne(
      { _id: 'recruitment', waitlist_alert_sent: { $ne: true } },
      { $set: { waitlist_alert_sent: true } },
      { upsert: true }
    ).catch((err) => (err.code === 11000 ? { modifiedCount: 0, upsertedCount: 0 } : Promise.reject(err)));
    if (!claimed.modifiedCount && !claimed.upsertedCount) return { alerted: false };

    const channelId = process.env.DISCORD_CHANNEL_GLOBAL_CHEF;
    if (channelId) {
      const places = open.map((g) => `${g.name} (${g.free_places} place${g.free_places > 1 ? 's' : ''})`).join(', ');
      const link = siteUrl('/admin?tab=applications');
      await sendDiscordMessage({
        channel_id: channelId,
        content: [
          `🔔 **Une place s'est libérée** : ${places}`,
          `${waiting} candidat${waiting > 1 ? 's' : ''} en liste d'attente${link ? ` → ${link}` : ''}`,
        ].join('\n'),
      });
    }
    return { alerted: true };
  } catch (err) {
    logger.error('[recruitment] Vérification de la liste d\'attente échouée (non bloquant):', err.message);
    return { alerted: false };
  }
};
