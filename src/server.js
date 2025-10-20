import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { MongoClient, ObjectId } from 'mongodb';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import * as dotenv from 'dotenv';
dotenv.config();

const app = express();

// Configuration CORS simplifiée pour JWT
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173'
}));

app.use(express.json());

if (typeof (PhusionPassenger) !== 'undefined') {
  PhusionPassenger.configure({ autoInstall: false });
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('❌ MONGODB_URI manquant');
  process.exit(1);
}

const client = new MongoClient(uri);

let db;

async function initDb() {
  try {
    await client.connect();
    db = client.db('schrift');
    console.log('✅ Connecté à MongoDB');
  } catch (err) {
    console.error('❌ Connexion MongoDB échouée:', err.message);
    // si la DB est indispensable, on stoppe pour que Passenger relance
    process.exit(1);
  }
}
initDb();

// Middleware pour vérifier le JWT
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
  
  if (!token) {
    return res.status(401).json({ success: false, message: 'Token d\'authentification requis' });
  }

  try {
    const jwtSecret = process.env.JWT_SECRET || 'votre-jwt-secret-super-securise';
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

// Middleware simple pour éviter d’appeler la DB avant qu’elle soit prête
function requireDb(req, res, next) {
  if (!db) return res.status(503).json({ error: 'DB non prête' });
  next();
}

app.get('/', (_req, res) => {
  res.send('API Schrift est en cours d\'exécution');
});

// Récupérer toutes les guildes
app.get('/api/guildes', async (_req, res) => {
  try {
    const guildes = await db.collection('guildes').find().toArray();
    res.json(guildes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Récupérer les membres d'une guilde
app.get('/api/guildes/:id/membres', async (req, res) => {
  try {
    const membres = await db.collection('membres').find({ guilde_id: req.params.id }).toArray();
    res.json(membres);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ajouter une guilde
app.post('/api/guildes', async (req, res) => {
  try {
    const result = await db.collection('guildes').insertOne(req.body);
    res.json({ insertedId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Renommer une guilde
app.put('/api/guildes/:id', async (req, res) => {
  try {
    await db.collection('guildes').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { name: req.body.name } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Supprimer une guilde
app.delete('/api/guildes/:id', async (req, res) => {
  try {
    await db.collection('guildes').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ajouter un membre à une guilde
app.post('/api/guildes/:id/membres', async (req, res) => {
  try {
    const membre = { ...req.body, guilde_id: req.params.id };
    const result = await db.collection('membres').insertOne(membre);
    res.json({ insertedId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Changer le role d'un membre
app.put('/api/membres/:id/role', async (req, res) => {
  try {
    await db.collection('membres').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { role: req.body.role } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Déplacer un membre vers une autre guilde
app.put('/api/membres/:id/guilde', async (req, res) => {
  try {
    await db.collection('membres').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { guilde_id: req.body.guilde_id, role: 'membre' } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Supprimer un membre
app.delete('/api/membres/:id', async (req, res) => {
  try {
    await db.collection('membres').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rotations (CRUD basique)
app.get('/api/rotations', async (_req, res) => {
  try {
    const rotations = await db.collection('rotations').find().toArray();
    res.json(rotations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rotations', async (req, res) => {
  try {
    const result = await db.collection('rotations').insertOne(req.body);
    res.json({ insertedId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scores (CRUD basique)
app.get('/api/scores', async (_req, res) => {
  try {
    const scores = await db.collection('scores').find().toArray();
    res.json(scores);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scores', async (req, res) => {
  try {
    const result = await db.collection('scores').insertOne(req.body);
    res.json({ insertedId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/login', async (req, res) => {
  try {
    const { password } = req.body;
    console.log("password reçu:", password);

    if (!password) {
      return res.status(400).json({ success: false, message: 'Mot de passe requis' });
    }

    const adminDoc = await db.collection('admin').findOne({ role: 'admin' });
    
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

// Route pour vérifier le statut d'authentification
app.get('/api/admin/verify', requireAdmin, (req, res) => {
  res.json({ 
    authenticated: true, 
    user: req.user,
    message: 'Token valide'
  });
});

// Route pour rafraîchir le token
app.post('/api/admin/refresh', requireAdmin, (req, res) => {
  try {
    const jwtSecret = process.env.JWT_SECRET || 'votre-jwt-secret-super-securise';
    const newToken = jwt.sign(
      { 
        role: 'admin',
        loginTime: req.user.loginTime, // Garder l'heure de login originale
        userId: req.user.userId,
        refreshed: new Date()
      },
      jwtSecret,
      { expiresIn: '24h' }
    );
    
    res.json({ 
      success: true,
      token: newToken,
      expiresIn: '24h'
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur lors du rafraîchissement' });
  }
});

// Route pour créer/modifier le mot de passe admin
app.post('/api/admin/setup', async (req, res) => {
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

    await db.collection('admin').replaceOne(
      { role: 'admin' },
      { role: 'admin', passwordHash: passwordHash, updatedAt: new Date() },
      { upsert: true }
    );

    res.json({ success: true, message: 'Mot de passe admin configuré avec succès' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Erreur serveur', error: err.message });
  }
});

// ===== ROUTES PROTÉGÉES (Exemples) =====

// Route d'administration protégée
app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    const stats = {
      guildesCount: await db.collection('guildes').countDocuments(),
      membresCount: await db.collection('membres').countDocuments(),
      rotationsCount: await db.collection('rotations').countDocuments(),
      scoresCount: await db.collection('scores').countDocuments(),
      serverTime: new Date(),
      userInfo: req.user
    };
    
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Supprimer toutes les données (route ultra-protégée)
app.delete('/api/admin/reset-all', requireAdmin, async (req, res) => {
  try {
    await db.collection('guildes').deleteMany({});
    await db.collection('membres').deleteMany({});
    await db.collection('rotations').deleteMany({});
    await db.collection('scores').deleteMany({});
    
    res.json({ 
      success: true, 
      message: 'Toutes les données ont été supprimées',
      timestamp: new Date()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`API démarrée sur http://0.0.0.0:${port}`);
});