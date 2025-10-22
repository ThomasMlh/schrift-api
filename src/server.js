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
    const { name } = req.body;
    
    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: 'Le nom de la guilde est requis' });
    }

    // Vérifier si une guilde avec ce nom existe déjà
    const existingGuilde = await db.collection('guildes').findOne({ 
      name: { $regex: new RegExp(`^${name.trim()}$`, 'i') } // Insensible à la casse
    });

    if (existingGuilde) {
      return res.status(409).json({ 
        success: false, 
        message: 'Une guilde avec ce nom existe déjà' 
      });
    }

    const result = await db.collection('guildes').insertOne({ 
      ...req.body, 
      name: name.trim() // Nettoyer le nom
    });
    
    res.json({ 
      success: true,
      insertedId: result.insertedId, 
      message: `Guilde ${name.trim()} ajoutée avec succès`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Renommer une guilde
app.put('/api/guildes/:id', async (req, res) => {
  try {
    const { name } = req.body;
    const guildeId = req.params.id;
    
    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: 'Le nom de la guilde est requis' });
    }

    // Vérifier si une autre guilde avec ce nom existe déjà (excluant la guilde actuelle)
    const existingGuilde = await db.collection('guildes').findOne({ 
      name: { $regex: new RegExp(`^${name.trim()}$`, 'i') },
      _id: { $ne: new ObjectId(guildeId) }
    });

    if (existingGuilde) {
      return res.status(409).json({ 
        success: false, 
        message: 'Une autre guilde avec ce nom existe déjà' 
      });
    }

    await db.collection('guildes').updateOne(
      { _id: new ObjectId(guildeId) },
      { $set: { name: name.trim() } }
    );

    res.json({ success: true, message: `Guilde renommée en ${name.trim()}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Supprimer une guilde
app.delete('/api/guildes/:id', async (req, res) => {
  try {
    const guilde = await db.collection('guildes').findOne({ _id: new ObjectId(req.params.id) });
    if (!guilde) return res.status(404).json({ success: false, message: 'Guilde non trouvée' });

    await db.collection('guildes').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true, message: `Guilde ${guilde.name} supprimée avec succès` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ajouter un membre à une guilde
app.post('/api/guildes/:id/membres', async (req, res) => {
  try {
    const guildeId = req.params.id;
    const role = req.body.role || 'membre';

    // Vérifications des contraintes de rôle
    if (role === 'chef') {
      const chefCount = await db.collection('membres').countDocuments({ guilde_id: guildeId, role: 'chef' });
      if (chefCount >= 1) {
        return res.status(400).json({ success: false, message: 'Il ne peut y avoir qu\'un seul chef dans une guilde' });
      }
    }

    if (role === 'sous-chef') {
      const sousChefCount = await db.collection('membres').countDocuments({ guilde_id: guildeId, role: 'sous-chef' });
      if (sousChefCount >= 2) {
        return res.status(400).json({ success: false, message: 'Il ne peut y avoir que deux sous-chefs dans une guilde' });
      }
    }

    // Vérifications de si la guilde a 20 membres ou non
    const memberCount = await db.collection('membres').countDocuments({ guilde_id: guildeId });
    if (memberCount >= 20) {
      return res.status(400).json({ success: false, message: 'Une guilde ne peut pas avoir plus de 20 membres' });
    }

    const membre = { ...req.body, guilde_id: guildeId };
    const result = await db.collection('membres').insertOne(membre);
    res.json({ insertedId: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Changer le role d'un membre
app.put('/api/membres/:id/role', async (req, res) => {
  try {
    const memberId = req.params.id;
    const newRole = req.body.role;

    if (!newRole) return res.status(400).json({ success: false, message: 'Role requis' });

    const member = await db.collection('membres').findOne({ _id: new ObjectId(memberId) });
    if (!member) return res.status(404).json({ success: false, message: 'Membre non trouvé' });

    const guildeId = member.guilde_id;

    // Vérifier contraintes si on veut passer en chef ou sous-chef
    if (newRole === 'chef') {
      const chefCount = await db.collection('membres').countDocuments({ guilde_id: guildeId, role: 'chef', _id: { $ne: new ObjectId(memberId) } });
      if (chefCount >= 1) {
        return res.status(400).json({ success: false, message: 'Il ne peut y avoir qu\'un seul chef dans une guilde' });
      }
    }

    if (newRole === 'sous-chef') {
      const sousChefCount = await db.collection('membres').countDocuments({ guilde_id: guildeId, role: 'sous-chef', _id: { $ne: new ObjectId(memberId) } });
      if (sousChefCount >= 2) {
        return res.status(400).json({ success: false, message: 'Il ne peut y avoir que deux sous-chefs dans une guilde' });
      }
    }

    await db.collection('membres').updateOne(
      { _id: new ObjectId(memberId) },
      { $set: { role: newRole } }
    );
    res.json({ success: true, message: `Le rôle de ${member.name} a été mis à jour avec succès. De ${member.role} à ${newRole}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Déplacer un membre vers une autre guilde (rôle automatiquement "membre")
app.put('/api/membres/:id/guilde', async (req, res) => {
  try {
    const memberId = req.params.id;
    const newGuildeId = req.body.guilde_id;

    if (!newGuildeId) return res.status(400).json({ success: false, message: 'guilde_id requis' });

    const member = await db.collection('membres').findOne({ _id: new ObjectId(memberId) });
    if (!member) return res.status(404).json({ success: false, message: 'Membre non trouvé' });

    // Forcer le rôle "membre" lors du déplacement (plus simple et logique)
    await db.collection('membres').updateOne(
      { _id: new ObjectId(memberId) },
      { $set: { guilde_id: newGuildeId, role: 'membre' } }
    );

    res.json({ success: true, message: `Membre ${member.name} déplacé avec le rôle "membre"` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Supprimer un membre
app.delete('/api/membres/:id', async (req, res) => {
  try {
    const member = await db.collection('membres').findOne({ _id: new ObjectId(req.params.id) });
    if (!member) return res.status(404).json({ success: false, message: 'Membre non trouvé' });

    await db.collection('membres').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true, message: `Membre ${member.name} supprimé avec succès` });
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


const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`API démarrée sur http://0.0.0.0:${port}`);
});