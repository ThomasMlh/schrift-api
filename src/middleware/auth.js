import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { buildGuildRoles } from '../utils/bbsAccounts.js';

// Bearer token from the Authorization header
const getBearerToken = (req) => {
  const authHeader = req.headers.authorization;
  return authHeader && authHeader.split(' ')[1];
};

// Shared factory for the requireXxx middlewares: extracts the token, answers 401 when missing and
// 403 when invalid/expired. `handler(decoded, req, res, next)` only holds each middleware's
// authorization logic (it may be async: a rejection is forwarded to next).
const withVerifiedToken = (handler) => (req, res, next) => {
  const token = getBearerToken(req);

  if (!token) {
    return res.status(401).json({ success: false, message: 'Token d\'authentification requis' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(403).json({ success: false, message: 'Token invalide ou expiré' });
  }
  return Promise.resolve(handler(decoded, req, res, next)).catch(next);
};

const getDb = (req) => req.db || req.app?.locals?.db;

// The token's grants are a snapshot taken at login: the current account state comes from the
// database, so a ban, demotion or guild change applies immediately.
const loadTokenUser = (db, decoded) => {
  const projection = { bbs_accounts: 1, is_banned: 1 };
  if (decoded._id && ObjectId.isValid(decoded._id)) {
    return db.collection('users').findOne({ _id: new ObjectId(decoded._id) }, { projection });
  }
  if (decoded.discord_id) return db.collection('users').findOne({ discord_id: decoded.discord_id }, { projection });
  return null;
};

// Whether the user (set by requireScoresAccess) may act on this guild
export const canManageGuild = (user, guildId) =>
  Boolean(user?.hasFullAccess || (guildId && (user?.allowedGuildIds || []).includes(String(guildId))));

// Admin-only routes
export const requireAdmin = withVerifiedToken((decoded, req, res, next) => {
  if (!decoded.is_admin) {
    return res.status(403).json({ success: false, message: 'Droits administrateur requis' });
  }

  req.user = decoded;
  next();
});

// Any logged-in user (admin, or player through Discord) whose account still exists and is not banned
export const requireAuth = withVerifiedToken(async (decoded, req, res, next) => {
  req.user = decoded;
  if (decoded.is_admin) return next();

  const db = getDb(req);
  if (!db) return res.status(503).json({ success: false, error: 'Base de données non disponible' });
  const user = await loadTokenUser(db, decoded);
  if (!user || user.is_banned) {
    return res.status(403).json({ success: false, message: 'Compte introuvable ou banni' });
  }
  next();
});

// Score routes: admins, or guild leaders/officers
export const requireScoresAccess = withVerifiedToken(async (decoded, req, res, next) => {
  req.user = decoded;

  if (decoded.is_admin) {
    req.user.hasFullAccess = true;
    return next();
  }

  const db = getDb(req);
  if (!db) return res.status(503).json({ success: false, error: 'Base de données non disponible' });
  const user = await loadTokenUser(db, decoded);
  if (!user || user.is_banned) {
    return res.status(403).json({ success: false, message: 'Compte introuvable ou banni' });
  }

  // Otherwise one of the user's bbs accounts must be a guild leader or officer.
  // One grant per leader/officer account: a leader on an alt only gets access to THAT account's
  // guild(s), never to every guild.
  const guildRoles = buildGuildRoles(user.bbs_accounts);
  req.user.guild_roles = guildRoles;
  if (guildRoles.length > 0) {
    req.user.hasFullAccess = false;
    req.user.allowedGuildIds = [...new Set(guildRoles.map(g => g.guilde_id).filter(Boolean))];
    if (req.user.allowedGuildIds.length === 0) {
      return res.status(403).json({
        success: false,
        message: 'Chef/Sous-chef doit être assigné à une guilde'
      });
    }
    return next();
  }

  return res.status(403).json({
    success: false,
    message: 'Droits insuffisants. Seuls les admins, chefs et sous-chefs peuvent effectuer cette opération'
  });
});

// Optional auth: sets req.user when a valid token is present, continues otherwise
export const optionalAuth = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (token) req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    req.user = null;
  }
  next();
};

// Rejects a route parameter that is not a valid MongoDB ObjectId
export const validateObjectIdParam = (paramName, message) => (req, res, next) => {
  if (!ObjectId.isValid(req.params[paramName])) {
    return res.status(400).json({ success: false, message: message || 'Format d\'ID invalide' });
  }
  next();
};

// Rejects requests until the DB is ready
export const requireDb = (req, res, next) => {
  if (!req.app.locals.db && !req.db) {
    return res.status(503).json({ 
      success: false, 
      error: 'Base de données non disponible' 
    });
  }
  
  if (!req.db && req.app.locals.db) {
    req.db = req.app.locals.db;
  }
  
  next();
}