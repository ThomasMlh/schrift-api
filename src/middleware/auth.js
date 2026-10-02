import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';

// Extrait le Bearer token du header Authorization
const getBearerToken = (req) => {
  const authHeader = req.headers.authorization;
  return authHeader && authHeader.split(' ')[1];
};

// Factory partagée par les middlewares "requireXxx" : gère l'extraction du
// token, le 401 si absent, la vérification JWT et le 403 si invalide/expiré.
// `handler(decoded, req, res, next)` ne porte que la logique d'autorisation
// propre à chaque middleware.
const withVerifiedToken = (handler) => (req, res, next) => {
  const token = getBearerToken(req);

  if (!token) {
    return res.status(401).json({ success: false, message: 'Token d\'authentification requis' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return handler(decoded, req, res, next);
  } catch (err) {
    return res.status(403).json({ success: false, message: 'Token invalide ou expiré' });
  }
};

// Middleware pour vérifier le JWT
export const requireAdmin = withVerifiedToken((decoded, req, res, next) => {
  // Vérifier que c'est bien un token admin
  if (!decoded.is_admin) {
    return res.status(403).json({ success: false, message: 'Droits administrateur requis' });
  }

  req.user = decoded; // Ajouter les infos du token à la requête
  next();
});

// Middleware pour les scores - Admin ou Chef/Sous-Chef de guilde
export const requireScoresAccess = withVerifiedToken((decoded, req, res, next) => {
  req.user = decoded;

  // Si c'est un admin, accès total
  if (decoded.is_admin) {
    req.user.hasFullAccess = true;
    return next();
  }

  // Sinon, vérifier si un des comptes bbs du user est chef ou sous-chef d'une guilde.
  // guild_roles est un tableau (un grant par compte chef/sous-chef) : un chef sur un alt
  // n'obtient un accès que sur la/les guilde(s) de CE compte, jamais sur toutes les guildes.
  const guildRoles = Array.isArray(decoded.guild_roles) ? decoded.guild_roles : [];
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

  // Ni admin, ni chef, ni sous-chef
  return res.status(403).json({
    success: false,
    message: 'Droits insuffisants. Seuls les admins, chefs et sous-chefs peuvent effectuer cette opération'
  });
});

// Auth optionnel — peuple req.user si le token est présent, continue sans erreur sinon
export const optionalAuth = (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (token) req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    req.user = null;
  }
  next();
};

// Middleware factory : valide qu'un param de route est un ObjectId MongoDB valide
export const validateObjectIdParam = (paramName, message) => (req, res, next) => {
  if (!ObjectId.isValid(req.params[paramName])) {
    return res.status(400).json({ success: false, message: message || 'Format d\'ID invalide' });
  }
  next();
};

// Middleware simple pour éviter d'appeler la DB avant qu'elle soit prête
export const requireDb = (req, res, next) => {
  if (!req.app.locals.db && !req.db) {
    return res.status(503).json({ 
      success: false, 
      error: 'Base de données non disponible' 
    });
  }
  
  // Assurer que req.db est défini
  if (!req.db && req.app.locals.db) {
    req.db = req.app.locals.db;
  }
  
  next();
}