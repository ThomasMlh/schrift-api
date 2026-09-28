import { getDB } from '../config/database.js';
import { logger } from './logger.js';

/**
 * Utilitaire pour envoyer des notifications au bot Discord via son serveur HTTP,
 * et journaliser chaque événement dans `activity_log` (consultable sur le site,
 * indépendamment de l'état d'activation Discord).
 *
 * Variables d'environnement :
 *   BOT_WEBHOOK_URL  — URL de base du bot (ex: http://localhost:8080)
 *   DISCORD_CHANNEL_DEFAULT — Channel par défaut si aucun channelId fourni
 */

// Résout les settings applicables à ce channel : ceux de la guilde propriétaire
// du channel si elle en a un, sinon les settings globaux (types hors-guilde comme `ban`).
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

const logActivity = async (db, { type, data, channel, guildeId }) => {
  try {
    await db.collection('activity_log').insertOne({
      type,
      data,
      channel_id: channel || null,
      guilde_id: guildeId,
      created_at: new Date(),
    });
  } catch (err) {
    logger.error(`[notifyDiscord] Erreur écriture activity_log (non bloquant): ${err.message}`);
  }
};

/**
 * Envoie une notification au bot Discord (sauf si désactivée dans les settings)
 * et journalise systématiquement l'événement dans activity_log.
 * @param {string} type       — Type de notification (scores, character_update, generic, ...)
 * @param {object} data       — Données à envoyer (structure dépend du type)
 * @param {string} [channelId] — ID du channel Discord (sinon fallback sur DISCORD_CHANNEL_DEFAULT)
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
    // getDB() peut jeter si la DB n'est pas encore initialisée (ex: script hors serveur) — non bloquant
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

  // Timeout de sécurité : les appelants attendent désormais cet appel avant de répondre (cf.
  // routes scores/users/membres/podium), donc un bot injoignable ne doit pas bloquer
  // indéfiniment leur réponse. 90s laisse la marge pour une capture podium (Playwright) avec
  // retries côté bot ; au-delà, on abandonne et on log, comme pour toute autre erreur réseau.
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
    // Non bloquant : on log l'erreur mais on ne fait pas échouer la requête API
    logger.error(`[notifyDiscord] Impossible de joindre le bot: ${err.message}`);
  } finally {
    clearTimeout(timeoutId);
  }
};
