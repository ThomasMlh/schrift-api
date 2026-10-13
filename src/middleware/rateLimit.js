import rateLimit from 'express-rate-limit';

// Protects the authentication endpoints (Discord code exchange, token refresh) against brute force
// and flooding: 20 attempts per IP per 15 min.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Trop de tentatives, réessaie dans quelques minutes'
  }
});
