/**
 * Utilitaire pour envoyer des notifications au bot Discord via son serveur HTTP.
 *
 * Variables d'environnement :
 *   BOT_WEBHOOK_URL  — URL de base du bot (ex: http://localhost:8080)
 *   DISCORD_CHANNEL_DEFAULT — Channel par défaut si aucun channelId fourni
 */

/**
 * Envoie une notification au bot Discord.
 * @param {string} type       — Type de notification (scores, character_update, generic)
 * @param {object} data       — Données à envoyer (structure dépend du type)
 * @param {string} [channelId] — ID du channel Discord (sinon fallback sur DISCORD_CHANNEL_DEFAULT)
 */
export const notifyDiscord = async (type, data, channelId) => {
  const botUrl = `${process.env.BOT_WEBHOOK_URL || 'http://localhost:8080'}/webhook`;
  const channel = channelId || process.env.DISCORD_CHANNEL_DEFAULT || '';
  if (!channel) {
    console.warn(`[notifyDiscord] Pas de channel configuré, notification ignorée.`);
    return;
  }

  const payload = { type, channel, data };

  try {
    const res = await fetch(botUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`[notifyDiscord] Erreur ${res.status}: ${body}`);
    } else {
      console.log(`[notifyDiscord] Notification '${type}' envoyée → channel ${channel}`);
    }
  } catch (err) {
    // Non bloquant : on log l'erreur mais on ne fait pas échouer la requête API
    console.error(`[notifyDiscord] Impossible de joindre le bot: ${err.message}`);
  }
}
