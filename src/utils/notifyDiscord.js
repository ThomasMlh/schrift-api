import { getDB } from '../config/database.js';
import { logger } from './logger.js';
import { logActivity } from './activityLog.js';

/**
 * Sends notifications to the Discord bot through its HTTP server, and logs every event in
 * `activity_log` (visible on the site, whether or not Discord notifications are enabled).
 *
 * Environment variables:
 *   BOT_WEBHOOK_URL         - bot base URL (e.g. http://localhost:8080)
 *   DISCORD_CHANNEL_DEFAULT - default channel when no channelId is given
 */

// Settings that apply to this channel: those of the guild owning the channel when there is one,
// otherwise the global settings (non-guild types such as `ban`).
const resolveNotificationSettings = async (db, channel) => {
  try {
    const guilde = channel
      ? await db.collection('guildes').findOne(
          { $or: [{ discord_channel_id: channel }, { discord_general_channel_id: channel }] },
          { projection: { _id: 1, disabled_notification_types: 1 } }
        )
      : null;

    if (guilde) {
      return { guildeId: guilde._id.toString(), disabledTypes: guilde.disabled_notification_types || [] };
    }

    const globalSettings = await db.collection('app_settings').findOne({ _id: 'notifications' });
    return { guildeId: null, disabledTypes: globalSettings?.disabled_notification_types || [] };
  } catch (err) {
    logger.error(`[notifyDiscord] Erreur résolution settings (non bloquant): ${err.message}`);
    return { guildeId: null, disabledTypes: [] };
  }
};

/**
 * Sends a notification to the Discord bot (unless disabled in the settings) and always logs the
 * event in activity_log.
 * @param {string} type        - Notification type (scores, character_update, generic, …)
 * @param {object} data        - Payload (shape depends on the type)
 * @param {string} [channelId] - Discord channel id (defaults to DISCORD_CHANNEL_DEFAULT)
 */
export const notifyDiscord = async (type, data, channelId) => {
  const botUrl = `${process.env.BOT_WEBHOOK_URL || 'http://localhost:8080'}/webhook`;
  const channel = channelId || process.env.DISCORD_CHANNEL_DEFAULT || '';

  let settings = { guildeId: null, disabledTypes: [] };
  try {
    const db = getDB();
    settings = await resolveNotificationSettings(db, channel);
    await logActivity(db, { type, data, channel, guildeId: settings.guildeId });
  } catch (err) {
    // getDB() may throw when the DB is not initialized yet (e.g. a standalone script); non-blocking
    logger.error(`[notifyDiscord] Journalisation/settings indisponibles (non bloquant): ${err.message}`);
  }

  if (settings.disabledTypes.includes(type)) {
    logger.info(`[notifyDiscord] Type '${type}' désactivé pour ce channel, envoi Discord ignoré.`);
    return;
  }

  if (!channel) {
    logger.warn(`[notifyDiscord] Pas de channel configuré, notification ignorée.`);
    return;
  }

  const payload = { type, channel, data };

  // Safety timeout: callers await this call before responding (score/user/member/podium routes), so
  // an unreachable bot must not block their response forever. 90s leaves room for a podium capture
  // (Playwright) with bot-side retries; beyond that, give up and log like any network error.
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 90000);

  try {
    const res = await fetch(botUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: abortController.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      logger.error(`[notifyDiscord] Erreur ${res.status}: ${body}`);
    } else {
      logger.info(`[notifyDiscord] Notification '${type}' envoyée → channel ${channel}`);
    }
  } catch (err) {
    // Non-blocking: log the error without failing the API request
    logger.error(`[notifyDiscord] Impossible de joindre le bot: ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }
};
