import { logger } from './logger.js';

/**
 * Appels HTTP synchrones vers le bot Discord, contrairement à notifyDiscord.js qui est
 * fire-and-forget. Utilisé pour lister les salons/membres et envoyer un message composé
 * depuis le site — des opérations dont l'appelant a besoin du résultat (ou de l'erreur).
 *
 * Variables d'environnement :
 *   BOT_WEBHOOK_URL    — URL de base du bot (ex: http://localhost:8080)
 *   BOT_WEBHOOK_SECRET — secret partagé, envoyé en Bearer token. Le bot refuse ces deux
 *                        routes (503) tant qu'il n'a pas le même secret configuré.
 */
const botUrl = (path) => `${(process.env.BOT_WEBHOOK_URL || 'http://localhost:8080').replace(/\/$/, '')}${path}`;

const authHeaders = () => ({
  'Content-Type': 'application/json',
  ...(process.env.BOT_WEBHOOK_SECRET && { Authorization: `Bearer ${process.env.BOT_WEBHOOK_SECRET}` }),
});

// Erreur avec .statusCode, cohérent avec le reste de l'API (cf. podiumService.js et consorts) :
// une route appelante peut la laisser remonter telle quelle via sendStatusCodeError.
const botError = (status, message) => Object.assign(new Error(message), { statusCode: status >= 400 && status < 500 ? status : 502 });

/**
 * Liste les salons textuels visibles par le bot, avec les membres ayant accès à chacun.
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
 * Liste les emojis custom (disponibles) des serveurs où se trouve le bot.
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
 * Envoie un message à un salon via le bot.
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

// La synchronisation lit le profil Discord de chaque joueur : elle peut prendre une à deux minutes.
const SYNC_PROFILES_TIMEOUT_MS = 180_000;

/**
 * Lance la synchronisation des bannières, avatars et pseudos Discord des users par le bot.
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
