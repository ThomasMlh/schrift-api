import { logger } from './logger.js';

// Writes an event to activity_log (the admin "Activité" tab); never blocks the caller
export const logActivity = async (db, { type, data, channel = null, guildeId = null }) => {
  try {
    await db.collection('activity_log').insertOne({
      type,
      data,
      channel_id: channel || null,
      guilde_id: guildeId,
      created_at: new Date(),
    });
  } catch (err) {
    logger.error(`[activityLog] Erreur écriture activity_log (non bloquant): ${err.message}`);
  }
};
