import { getTopAchievements } from '../achievements.js';
import { logger } from '../../utils/logger.js';

// Adds each ranking row's rarest achievement (top_achievement), shown next to the name. Never fails
// the podium: on error, rows are returned unchanged.
export const attachTopAchievements = async (db, rows) => {
  try {
    const top = await getTopAchievements(db, [...new Set(rows.map((r) => r.bbs_id).filter(Boolean))]);
    for (const row of rows) row.top_achievement = top.get(row.bbs_id) || null;
  } catch (err) {
    logger.error('[podium] Succès indisponibles (non bloquant):', err.message);
  }
  return rows;
};
