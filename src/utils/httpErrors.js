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
// pratique, tous les throw des services posent un message). logLabel est le
// texte du log serveur ; par défaut identique à fallbackMessage (+ ':'), mais
// certaines routes avaient un texte de log différent du message renvoyé au
// client — passer logLabel explicitement pour reproduire ce texte-là.
// error.details, s'il existe, est propagé tel quel (une seule route l'utilise
// aujourd'hui ; no-op partout ailleurs puisque rien d'autre ne pose .details).
export const sendStatusCodeError = (res, error, fallbackMessage, logLabel = `${fallbackMessage}:`) => {
  const status = error.statusCode || 500;
  if (status === 500) logger.error(logLabel, error);
  res.status(status).json({
    success: false,
    message: error.message || fallbackMessage,
    ...(error.details && { details: error.details }),
  });
};

// Variante utilisée par users.js : masque error.message derrière un message
// générique quand le statut est 500 (erreur serveur inattendue), pour ne
// jamais exposer un message d'erreur interne au client dans ce cas précis —
// seules les erreurs métier avec un .statusCode explicite gardent leur
// message d'origine.
export const sendHiddenServiceError = (res, error, logLabel, fallbackMessage = 'Erreur serveur') => {
  const status = error.statusCode || 500;
  if (status === 500) logger.error(logLabel, error);
  const message = status !== 500 ? error.message : fallbackMessage;
  res.status(status).json({ success: false, message });
};
