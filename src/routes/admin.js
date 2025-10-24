import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { requireDb } from '../middleware/auth.js';

const router = express.Router();

// Middleware pour toutes les routes admin
router.use(requireDb);

// Route de connexion admin
router.post('/login', async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ success: false, message: 'Mot de passe requis' });
    }

    const adminDoc = await req.db.collection('admin').findOne({ role: 'admin' });

    if (!adminDoc || !adminDoc.passwordHash) {
      return res.status(500).json({ success: false, message: 'Configuration admin non trouvée' });
    }

    const salt = process.env.PASSWORD_SALT;
    const computedHash = crypto.createHash('sha256').update(password + salt).digest('hex');

    if (computedHash === adminDoc.passwordHash) {
      const jwtSecret = process.env.JWT_SECRET;
      const token = jwt.sign(
        {
          role: 'admin',
          loginTime: new Date(),
          userId: adminDoc._id
        },
        jwtSecret,
        { expiresIn: '24h' }
      );

      return res.json({
        success: true,
        message: 'Authentification réussie',
        token: token,
        expiresIn: '24h'
      });
    }

    res.status(401).json({ success: false, message: 'Authentification échouée' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur', error: err.message });
  }
});

// Route pour créer/modifier le mot de passe admin
router.post('/setup', async (req, res) => {
  try {
    const { password, setupKey } = req.body;

    // Clé de sécurité pour éviter que n'importe qui puisse changer le mot de passe
    if (setupKey !== process.env.ADMIN_SETUP_KEY) {
      return res.status(403).json({ success: false, message: 'Clé de configuration invalide' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: 'Mot de passe trop court (min 6 caractères)' });
    }

    // Générer le hash SHA-256 déterministe (comme le front-end)
    const salt = process.env.PASSWORD_SALT || 'schrift-app-salt-2025';
    const passwordHash = crypto.createHash('sha256').update(password + salt).digest('hex');

    await req.db.collection('admin').replaceOne(
      { role: 'admin' },
      { role: 'admin', passwordHash: passwordHash, updatedAt: new Date() },
      { upsert: true }
    );

    res.json({ success: true, message: 'Mot de passe admin configuré avec succès' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur', error: err.message });
  }
});

export default router;