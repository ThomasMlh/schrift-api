import { logger } from './logger.js';

// Generic 500 error responses shared by route catch blocks.
// The two shapes match the two formats already used by existing routes; they are kept separate so
// every route keeps the exact response shape the front end expects.
export const sendServerError = (res, err) =>
  res.status(500).json({ error: err.message });

export const sendServerErrorWithFlag = (res, err) =>
  res.status(500).json({ success: false, error: err.message });

// For routes whose service throws an Error with an explicit .statusCode (400/403/404/…) for an
// expected business error, and without .statusCode for a real server error (which is then logged).
// fallbackMessage is used when error.message is empty; logLabel is the server log text (defaults to
// fallbackMessage + ':'). error.details, when present, is passed through as is.
export const sendStatusCodeError = (res, error, fallbackMessage, logLabel = `${fallbackMessage}:`) => {
  const status = error.statusCode || 500;
  if (status === 500) logger.error(logLabel, error);
  res.status(status).json({
    success: false,
    message: error.message || fallbackMessage,
    ...(error.details && { details: error.details }),
  });
};

// Variant that hides error.message behind a generic message on 500 (unexpected server error), so an
// internal error message is never exposed to the client; business errors with an explicit
// .statusCode keep their message.
export const sendHiddenServiceError = (res, error, logLabel, fallbackMessage = 'Erreur serveur') => {
  const status = error.statusCode || 500;
  if (status === 500) logger.error(logLabel, error);
  const message = status !== 500 ? error.message : fallbackMessage;
  res.status(status).json({ success: false, message });
};
