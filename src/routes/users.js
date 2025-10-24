import express from 'express';
import jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import { requireDb } from '../middleware/auth.js';

const router = express.Router();

// Middleware pour toutes les routes users
router.use(requireDb);

// Configuration pour récupérer JWT_SECRET
const getJwtSecret = () => process.env.JWT_SECRET;

// Middleware pour vérifier que l'utilisateur est admin
const requireAdmin = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ success: false, message: 'Token manquant' });
    }

    const decoded = jwt.verify(token, getJwtSecret());
    
    if (!decoded.isAdmin) {
      return res.status(403).json({ success: false, message: 'Accès refusé - Admin requis' });
    }

    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Token invalide ou expiré' });
    }
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
};

// Route pour récupérer tous les utilisateurs (accessible à tous)
router.get('/', async (req, res) => {
  try {
    const users = await req.db.collection('users').find({}, {
      projection: {
        _id: 1,
        discord_id: 1,
        username: 1,
        avatar: 1,
        guilde_id: 1,
        role: 1,
        is_admin: 1,
        last_login: 1
      }
    }).toArray();

    res.json({ success: true, users, count: users.length });
  } catch (error) {
    console.error('Erreur lors de la récupération des utilisateurs:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Route pour récupérer un utilisateur spécifique
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await req.db.collection('users').findOne(
      { discord_id: userId },
      {
        projection: {
          _id: 1,
          discord_id: 1,
          username: 1,
          avatar: 1,
          guilde_id: 1,
          role: 1,
          is_admin: 1,
          last_login: 1
        }
      }
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    res.json({ success: true, user });
  } catch (error) {
    console.error('Erreur lors de la récupération de l\'utilisateur:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Route pour mettre à jour le rôle d'un utilisateur (admin seulement)
router.put('/:userId/role', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    if (!role) {
      return res.status(400).json({ success: false, message: 'Le rôle est requis' });
    }

    // Récupérer l'utilisateur pour connaître sa guilde
    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    
    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    if (!user.guilde_id) {
      return res.status(400).json({ 
        success: false, 
        message: 'L\'utilisateur doit être dans une guilde pour avoir un rôle' 
      });
    }

    // Vérifier les contraintes de rôle
    if (role === 'chef') {
      const existingChef = await req.db.collection('users').findOne({ 
        guilde_id: user.guilde_id, 
        role: 'chef',
      });
      if (existingChef) {
        return res.status(400).json({ 
          success: false, 
          message: 'Il ne peut y avoir qu\'un seul chef dans une guilde' 
        });
      }
    }

    if (role === 'sous-chef') {
      const sousChefCount = await req.db.collection('users').countDocuments({ 
        guilde_id: user.guilde_id, 
        role: 'sous-chef',
      });
      if (sousChefCount >= 2) {
        return res.status(400).json({ 
          success: false, 
          message: 'Il ne peut y avoir que deux sous-chefs dans une guilde' 
        });
      }
    }

    // Mettre à jour le rôle
    const result = await req.db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      { $set: { role: role } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    res.json({ success: true, message: `Rôle mis à jour vers ${role}` });
  } catch (error) {
    console.error('Erreur lors de la mise à jour du rôle:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Route pour changer la guilde d'un utilisateur (admin seulement)
router.put('/:userId/guild', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { guildeId, role } = req.body;

    if (!guildeId) {
      return res.status(400).json({ success: false, message: 'L\'ID de la guilde est requis' });
    }

    const newRole = role || 'membre';

    // Vérifier les contraintes si un rôle spécifique est demandé
    if (newRole === 'chef') {
      const existingChef = await req.db.collection('users').findOne({ 
        guilde_id: guildeId, 
        role: 'chef',
        _id: { $ne: new ObjectId(userId) }
      });
      if (existingChef) {
        return res.status(400).json({ 
          success: false, 
          message: 'Il ne peut y avoir qu\'un seul chef dans une guilde' 
        });
      }
    }

    if (newRole === 'sous-chef') {
      const sousChefCount = await req.db.collection('users').countDocuments({ 
        guilde_id: guildeId, 
        role: 'sous-chef',
        _id: { $ne: new ObjectId(userId) }
      });
      if (sousChefCount >= 2) {
        return res.status(400).json({ 
          success: false, 
          message: 'Il ne peut y avoir que deux sous-chefs dans une guilde' 
        });
      }
    }

    // Mettre à jour la guilde et le rôle
    const result = await req.db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      { $set: { guilde_id: guildeId, role: newRole } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    res.json({ success: true, message: 'Utilisateur déplacé vers la nouvelle guilde' });
  } catch (error) {
    console.error('Erreur lors du changement de guilde:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Route pour récupérer les utilisateurs sans guilde
router.get('/without-guild', async (req, res) => {
  try {
    const users = await req.db.collection('users').find(
      { 
        $or: [
          { guilde_id: null },
          { guilde_id: { $exists: false } }
        ]
      },
      {
        projection: {
          _id: 1,
          discord_id: 1,
          username: 1,
          avatar: 1,
          is_admin: 1,
          last_login: 1
        }
      }
    ).toArray();

    res.json({ success: true, users, count: users.length });
  } catch (error) {
    console.error('Erreur lors de la récupération des utilisateurs sans guilde:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

export default router;