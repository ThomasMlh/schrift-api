import rateLimit from 'express-rate-limit';

// Limite les endpoints d'authentification (échange de code Discord, refresh
// de token) contre le brute-force et le flood : 20 tentatives / IP / 15 min.
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
