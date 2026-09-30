import { logger } from './logger.js';

// Réponses d'erreur 500 génériques, mutualisées pour ne plus dupliquer le
// même `res.status(500).json(...)` dans chaque bloc catch de route.
//
// Ces deux formes correspondent aux deux formats déjà utilisés par la
// majorité des routes existantes ; on ne les fusionne pas en un seul format
// pour ne rien changer côté frontend (chaque route garde exactement la même
// forme de réponse qu'avant).
export const sendServerError = (res, err) =>
  res.status(500).json({ error: err.message });

export const sendServerErrorWithFlag = (res, err) =>
  res.status(500).json({ success: false, error: err.message });

// Pour les routes dont le service appelé lève une Error avec un .statusCode
// explicite (400/403/404/...) pour une erreur métier attendue, et sans
// .statusCode pour une vraie erreur serveur (auquel cas on logue, cf.
// podiumService.js et routes/podium.js). fallbackMessage est le message
// affiché quand error.message est vide (n'arrive quasiment jamais en
// pratique, tous les throw des services posent un message).
//
// N'est appliqué qu'aux endroits où le comportement exact était déjà
// rigoureusement identique avant extraction (cf. commit history) : plusieurs
// routes de ce projet ont des variantes légèrement différentes (message
// masqué sur 500, champ `details` en plus, etc.) qu'on ne généralise pas ici
// pour ne rien changer de leur comportement.
export const sendStatusCodeError = (res, error, fallbackMessage) => {
  const status = error.statusCode || 500;
  if (status === 500) logger.error(`${fallbackMessage}:`, error);
  res.status(status).json({ success: false, message: error.message || fallbackMessage });
};
