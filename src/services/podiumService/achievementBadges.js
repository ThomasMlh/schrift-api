import { getTopAchievements } from '../achievements.js';
import { logger } from '../../utils/logger.js';

// Ajoute à chaque ligne de classement le succès le plus rare du compte (top_achievement), affiché
// à côté du pseudo. Ne fait jamais échouer le podium : en cas d'erreur, les lignes restent telles quelles.
export const attachTopAchievements = async (db, rows) => {
  try {
    const top = await getTopAchievements(db, [...new Set(rows.map((r) => r.bbs_id).filter(Boolean))]);
    for (const row of rows) row.top_achievement = top.get(row.bbs_id) || null;
  } catch (err) {
    logger.error('[podium] Succès indisponibles (non bloquant):', err.message);
  }
  return rows;
};
