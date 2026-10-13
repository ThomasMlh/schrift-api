import { logger } from './logger.js';

/**
 * Synchronous HTTP calls to the Discord bot, unlike notifyDiscord.js which is fire-and-forget. Used
 * to list channels/members and send a message composed on the site, operations whose caller needs the
 * result (or the error).
 *
 * Environment variables:
 *   BOT_WEBHOOK_URL    - bot base URL (e.g. http://localhost:8080)
 *   BOT_WEBHOOK_SECRET - shared secret, sent as a Bearer token. The bot rejects these routes (503)
 *                        until it has the same secret configured.
 */
const botUrl = (path) => `${(process.env.BOT_WEBHOOK_URL || 'http://localhost:8080').replace(/\/$/, '')}${path}`;

const authHeaders = () => ({
  'Content-Type': 'application/json',
  ...(process.env.BOT_WEBHOOK_SECRET && { Authorization: `Bearer ${process.env.BOT_WEBHOOK_SECRET}` }),
});

// Error carrying .statusCode, consistent with the rest of the API (see podiumService): a calling
// route can pass it through sendStatusCodeError as is.
const botError = (status, message) => Object.assign(new Error(message), { statusCode: status >= 400 && status < 500 ? status : 502 });

/**
 * Lists the text channels visible to the bot, with the members who can access each one.
 * @returns {Promise<Array<{id, name, guild_id, guild_name, members: Array<{id, username, display_name}>}>>}
 */
export const listDiscordChannels = async () => {
  let res;
  try {
    res = await fetch(botUrl('/channels'), { headers: authHeaders() });
  } catch (err) {
    logger.error('[botClient] Impossible de joindre le bot (GET /channels):', err.message);
    throw botError(502, 'Impossible de joindre le bot Discord');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw botError(res.status, body.error || `Le bot a répondu ${res.status}`);
  }

  const { channels } = await res.json();
  return channels || [];
};

/**
 * Lists the available custom emojis of the servers the bot is in.
 * @returns {Promise<Array<{id, name, animated, url, guild_id}>>}
 */
export const listDiscordEmojis = async () => {
  let res;
  try {
    res = await fetch(botUrl('/emojis'), { headers: authHeaders() });
  } catch (err) {
    logger.error('[botClient] Impossible de joindre le bot (GET /emojis):', err.message);
    throw botError(502, 'Impossible de joindre le bot Discord');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw botError(res.status, body.error || `Le bot a répondu ${res.status}`);
  }

  const { emojis } = await res.json();
  return emojis || [];
};

/**
 * Sends a message to a channel through the bot.
 * @param {{channel_id: string, content: string, mention_user_ids?: string[]}} params
 * @returns {Promise<{status: string, message_id: string, channel: string}>}
 */
export const sendDiscordMessage = async ({ channel_id, content, mention_user_ids = [] }) => {
  let res;
  try {
    res = await fetch(botUrl('/send-message'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ channel_id, content, mention_user_ids }),
    });
  } catch (err) {
    logger.error('[botClient] Impossible de joindre le bot (POST /send-message):', err.message);
    throw botError(502, 'Impossible de joindre le bot Discord');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw botError(res.status, body.error || `Le bot a répondu ${res.status}`);
  }

  return res.json();
};

// The sync reads every player's Discord profile: it can take one to two minutes.
const SYNC_PROFILES_TIMEOUT_MS = 180_000;

/**
 * Asks the bot to sync users' Discord banners, avatars and names.
 * @returns {Promise<{total, updated, unchanged, null_set, missing_on_server, lookup_errors,
 *   patch_errors, servers: string[], changed_players: Array<{name, discord_id, changes: string[]}>}>}
 */
export const syncDiscordProfiles = async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_PROFILES_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(botUrl('/sync-profiles'), {
      method: 'POST',
      headers: authHeaders(),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw botError(504, 'La synchronisation prend trop de temps : elle continue côté bot, réessayez plus tard');
    }
    logger.error('[botClient] Impossible de joindre le bot (POST /sync-profiles):', err.message);
    throw botError(502, 'Impossible de joindre le bot Discord');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw botError(res.status, body.error || `Le bot a répondu ${res.status}`);
  }

  return res.json();
};
