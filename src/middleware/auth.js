import jwt from 'jsonwebtoken';

// Middleware pour vérifier le JWT
export function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ success: false, message: 'Token d\'authentification requis' });
  }

  try {
    const jwtSecret = process.env.JWT_SECRET;
    const decoded = jwt.verify(token, jwtSecret);

    // Vérifier que c'est bien un token admin
    if (decoded.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Droits administrateur requis' });
    }

    req.user = decoded; // Ajouter les infos du token à la requête
    next();
  } catch (err) {
    return res.status(403).json({ success: false, message: 'Token invalide ou expiré' });
  }
}

// Middleware simple pour éviter d'appeler la DB avant qu'elle soit prête
export function requireDb(req, res, next) {
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