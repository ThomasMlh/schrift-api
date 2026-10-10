// Résultat d'un build : score obtenu sur la rotation et chronos des deux vagues (secondes, au
// millième près). Tous facultatifs ; null (ou chaîne vide) efface la valeur.

// Même plafond que les scores (MAX_PLAUSIBLE_SCORE dans services/achievements.js)
export const MAX_BUILD_SCORE = 625_000_000;
// Une vague dure bien moins d'une heure : au-delà, c'est une erreur de saisie
export const MAX_WAVE_SECONDS = 3600;

export const RESULT_FIELDS = ['score', 'time_normal_wave', 'time_extra_wave'];

const isEmpty = (v) => v === null || v === undefined || v === '';

/**
 * Valide et normalise les champs de résultat présents dans body.
 * @returns {{ values: Record<string, number|null>, error: string|null }} values ne contient que
 *   les champs fournis.
 */
export const parseBuildResult = (body = {}) => {
  const values = {};

  if ('score' in body) {
    if (isEmpty(body.score)) {
      values.score = null;
    } else {
      const score = Number(body.score);
      if (!Number.isInteger(score) || score < 0 || score > MAX_BUILD_SCORE) {
        return { values, error: `Le score doit être un entier entre 0 et ${MAX_BUILD_SCORE.toLocaleString('fr-FR')}` };
      }
      values.score = score;
    }
  }

  for (const field of ['time_normal_wave', 'time_extra_wave']) {
    if (!(field in body)) continue;
    if (isEmpty(body[field])) {
      values[field] = null;
      continue;
    }
    const seconds = Number(body[field]);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_WAVE_SECONDS) {
      return { values, error: `Le chrono (${field}) doit être un nombre de secondes entre 0 et ${MAX_WAVE_SECONDS}` };
    }
    values[field] = Math.round(seconds * 1000) / 1000;
  }

  return { values, error: null };
};
