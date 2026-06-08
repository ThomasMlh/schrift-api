import jwt from 'jsonwebtoken';

// Middleware pour vérifier le JWT
export const requireAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ success: false, message: 'Token d\'authentification requis' });
  }

  try {
    const jwtSecret = process.env.JWT_SECRET;
    const decoded = jwt.verify(token, jwtSecret);

    // Vérifier que c'est bien un token admin
    if (!decoded.is_admin) {
      return res.status(403).json({ success: false, message: 'Droits administrateur requis' });
    }

    req.user = decoded; // Ajouter les infos du token à la requête
    next();
  } catch (err) {
    return res.status(403).json({ success: false, message: 'Token invalide ou expiré' });
  }
}

// Middleware pour les scores - Admin ou Chef/Sous-Chef de guilde
export const requireScoresAccess = (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ success: false, message: 'Token d\'authentification requis' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.user = decoded;

    // Si c'est un admin, accès total
    if (decoded.is_admin) {
      req.user.hasFullAccess = true;
      return next();
    }

    // Sinon, vérifier si c'est chef ou sous-chef
    if (decoded.role === 'chef' || decoded.role === 'sous-chef') {
      if (!decoded.guilde_id) {
        return res.status(403).json({ 
          success: false, 
          message: 'Chef/Sous-chef doit être assigné à une guilde' 
        });
      }
      req.user.hasFullAccess = false;
      req.user.allowedGuildId = decoded.guilde_id;
      return next();
    }

    // Ni admin, ni chef, ni sous-chef
    return res.status(403).json({ 
      success: false, 
      message: 'Droits insuffisants. Seuls les admins, chefs et sous-chefs peuvent effectuer cette opération' 
    });

  } catch (err) {
    return res.status(403).json({ success: false, message: 'Token invalide ou expiré' });
  }
}

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