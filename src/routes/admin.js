import express from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { requireDb, requireAdmin } from '../middleware/auth.js';
import { syncDiscordProfiles } from '../utils/botClient.js';
import { sendStatusCodeError } from '../utils/httpErrors.js';
import { ensureIndexes } from '../services/dbIndexes.js';

const router = express.Router();

router.use(requireDb);

// POST admin login
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

// POST create or change the admin password
router.post('/setup', async (req, res) => {
  try {
    const { password, setupKey } = req.body;

    // Setup key, so the password cannot be changed by anyone
    if (setupKey !== process.env.ADMIN_SETUP_KEY) {
      return res.status(403).json({ success: false, message: 'Clé de configuration invalide' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: 'Mot de passe trop court (min 6 caractères)' });
    }

    // Deterministic SHA-256 hash (same as the front end)
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

// GET Discord bot health
router.get('/bot-health', requireAdmin, async (req, res) => {
  try {
    const healthUrl = `${process.env.BOT_WEBHOOK_URL || 'http://localhost:8080'}/health`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const botRes = await fetch(healthUrl, { signal: controller.signal });
      clearTimeout(timeout);
      const data = await botRes.json().catch(() => ({}));
      return res.json({ success: true, online: botRes.ok, status: botRes.status, data });
    } catch (fetchErr) {
      clearTimeout(timeout);
      const timedOut = fetchErr.name === 'AbortError';
      return res.json({ success: true, online: false, error: timedOut ? 'timeout' : fetchErr.message });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST resync players' Discord banners, avatars and names (admin "Tools" button)
router.post('/sync-profiles', requireAdmin, async (req, res) => {
  try {
    const result = await syncDiscordProfiles();
    res.json({ success: true, ...result });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur lors de la synchronisation des profils Discord');
  }
});

// POST create the database indexes (admin "Tools" button)
router.post('/create-indexes', requireAdmin, async (req, res) => {
  try {
    res.json({ success: true, ...(await ensureIndexes(req.db)) });
  } catch (err) {
    sendStatusCodeError(res, err, 'Erreur lors de la création des index');
  }
});

export default router;