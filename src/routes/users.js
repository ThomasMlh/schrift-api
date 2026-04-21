import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb, requireAdmin } from '../middleware/auth.js';
import { notifyDiscord } from '../utils/notifyDiscord.js';
import { getUserStats } from '../services/userStats.js';

const router = express.Router();

// Middleware pour toutes les routes users
router.use(requireDb);

// Route pour récupérer tous les utilisateurs avec pagination (accessible à tous)
router.get('/', async (req, res) => {
  try {
    // Paramètres de pagination avec valeurs par défaut
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50; // Harmonisé avec les autres routes
    const skip = (page - 1) * limit;

    // Limiter le nombre max par page pour éviter les abus
    const maxLimit = 200;
    const actualLimit = Math.min(limit, maxLimit);

    // Paramètres de filtrage optionnels
    const { guilde_id, role, search, is_banned } = req.query;

    // Construire la requête de filtrage
    const query = {};

    // Filtre par statut de bannissement
    if (is_banned === 'true') {
      query.is_banned = true;
    } else if (is_banned === 'false') {
      query.is_banned = { $ne: true };
    }

    // Filtre par guilde
    if (guilde_id && guilde_id.trim()) {
      query.guilde_id = guilde_id.trim();
    }

    // Filtre par rôle
    if (role && role.trim()) {
      query.role = role.trim();
    }

    // Filtre par recherche textuelle (nom d'utilisateur ou nom global)
    if (search && search.trim()) {
      const searchTerm = search.trim();
      query.$or = [
        { username: { $regex: searchTerm, $options: 'i' } },
        { global_name: { $regex: searchTerm, $options: 'i' } },
        { bbs_name: { $regex: searchTerm, $options: 'i' } },
        { discord_id: { $regex: searchTerm, $options: 'i' } },
        { bbs_id: { $regex: searchTerm, $options: 'i' } }
      ];
    }

    const users = await req.db.collection('users')
      .find(query, {
        projection: {
          _id: 1,
          discord_id: 1,
          username: 1,
          avatar: 1,
          banner: 1,
          guilde_id: 1,
          role: 1,
          is_admin: 1,
          last_login: 1,
          global_name: 1,
          bbs_id: 1,
          bbs_name: 1,
          is_authorized: 1,
          is_banned: 1,
          ban_reason: 1,
          banned_at: 1
        }
      })
      .sort({ last_login: -1 })
      .skip(skip)
      .limit(actualLimit)
      .toArray();

    const totalCount = await req.db.collection('users').countDocuments(query);
    const totalPages = Math.ceil(totalCount / actualLimit);

    res.json({
      success: true,
      users,
      pagination: {
        currentPage: page,
        totalPages,
        totalCount,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
        itemsPerPage: actualLimit,
        itemsOnPage: users.length
      },
      // Retourner les filtres actifs pour le frontend
      activeFilters: {
        guilde_id: guilde_id || null,
        role: role || null,
        search: search || null
      }
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des utilisateurs:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Route pour récupérer les utilisateurs sans guilde avec pagination
router.get('/without-guild', async (req, res) => {
  try {
    // Paramètres de pagination avec valeurs par défaut
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    // Limiter le nombre max par page pour éviter les abus
    const maxLimit = 200;
    const actualLimit = Math.min(limit, maxLimit);

    // Paramètre de recherche optionnel
    const { search } = req.query;

    // Construire la requête de base (sans guilde)
    const query = {
      $or: [
        { guilde_id: null },
        { guilde_id: { $exists: false } }
      ]
    };

    // Ajouter filtre de recherche si présent
    if (search && search.trim()) {
      const searchTerm = search.trim();
      query.$and = [
        query,
        {
          $or: [
            { username: { $regex: searchTerm, $options: 'i' } },
            { global_name: { $regex: searchTerm, $options: 'i' } }
          ]
        }
      ];
      // Restructurer la requête pour éviter les conflits
      delete query.$or;
      query.$and.unshift({
        $or: [
          { guilde_id: null },
          { guilde_id: { $exists: false } }
        ]
      });
    }

    const users = await req.db.collection('users')
      .find(query, {
        projection: {
          _id: 1,
          discord_id: 1,
          username: 1,
          avatar: 1,
          banner: 1,
          is_admin: 1,
          last_login: 1,
          global_name: 1,
          guilde_id: 1,
          role: 1,
          bbs_name: 1,
          bbs_id: 1,
          is_banned: 1,
          ban_reason: 1,
          banned_at: 1
        }
      })
      .sort({ bbs_name: 1 })
      .skip(skip)
      .limit(actualLimit)
      .toArray();

    const totalCount = await req.db.collection('users').countDocuments(query);
    const totalPages = Math.ceil(totalCount / actualLimit);

    res.json({
      success: true,
      users,
      pagination: {
        currentPage: page,
        totalPages,
        totalCount,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1,
        itemsPerPage: actualLimit,
        itemsOnPage: users.length
      },
      // Retourner les filtres actifs pour le frontend
      activeFilters: {
        search: search || null
      }
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des utilisateurs sans guilde:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Route pour récupérer un utilisateur spécifique
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    // Vérifier si l'userId est un ObjectId valide
    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Format d\'ID utilisateur invalide' 
      });
    }

    const user = await req.db.collection('users').findOne(
      { _id: new ObjectId(userId) },
      {
        projection: {
          _id: 1,
          discord_id: 1,
          username: 1,
          avatar: 1,
          banner: 1,
          guilde_id: 1,
          role: 1,
          is_admin: 1,
          last_login: 1,
          global_name: 1,
          bbs_id: 1,
          bbs_name: 1,
          is_authorized: 1,
          is_banned: 1,
          ban_reason: 1,
          banned_at: 1
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

router.patch('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const updates = req.body;

    // Vérifier si l'userId est un ObjectId valide
    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Format d\'ID utilisateur invalide' 
      });
    }

    const result = await req.db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      { $set: updates }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    const updatedUser = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });

    res.json({ success: true, message: `${updatedUser.global_name} mis à jour avec succès` });
  } catch (error) {
    console.error('Erreur lors de la mise à jour de l\'utilisateur:', error);
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
    let user;

    // Essayer d'abord comme ObjectId MongoDB, sinon comme discord_id
    if (ObjectId.isValid(userId)) {
      user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });
    } else {
      user = await req.db.collection('users').findOne({ discord_id: userId });
    }

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

    // Vérifier si l'userId est un ObjectId valide
    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Format d\'ID utilisateur invalide' 
      });
    }

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

    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });

    res.json({ success: true, message: `${user.global_name || 'Utilisateur'} déplacé vers la nouvelle guilde` });
  } catch (error) {
    console.error('Erreur lors du changement de guilde:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// GET statistiques personnelles d'un joueur par user_id
router.get('/:user_id/stats', async (req, res) => {
  try {
    const data = await getUserStats(req.db, req.params.user_id, req.query);
    return res.json({ success: true, data });

  } catch (error) {
    const status = error.statusCode || 500;
    const message = status !== 500 ? error.message : 'Erreur serveur lors de la récupération des statistiques';
    if (status === 500) console.error('Erreur lors de la récupération des statistiques du joueur:', error);
    return res.status(status).json({ success: false, message });
  }
});

// Route pour bannir un utilisateur (admin seulement)
router.post('/:userId/ban', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;

    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        message: 'Format d\'ID utilisateur invalide'
      });
    }

    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });

    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    if (user.is_admin) {
      return res.status(403).json({ success: false, message: 'Impossible de bannir un administrateur' });
    }

    if (user.is_banned) {
      return res.status(400).json({ success: false, message: 'Cet utilisateur est déjà banni' });
    }

    await req.db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      {
        $set: {
          is_banned: true,
          ban_reason: reason || null,
          banned_at: new Date(),
          banned_by: req.user.discord_id
        }
      }
    );

    // Notification Discord (non bloquante)
    try {
      const banner = await req.db.collection('users').findOne(
        { _id: new ObjectId(req.user._id) },
        { projection: { global_name: 1, username: 1, bbs_name: 1 } }
      );
      const bannerName = banner?.bbs_name || banner?.global_name || banner?.username || 'Inconnu';
      const bannedName = user.bbs_name || user.global_name || user.username || 'Inconnu';
      notifyDiscord('ban', {
        action: 'ban',
        banned_by: bannerName,
        banned_user: bannedName,
        reason: reason || null,
        banned_at: new Date().toISOString()
      }, process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
    } catch (notifErr) {
      console.error('[users/ban] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.json({
      success: true,
      message: `${user.global_name || user.username} a été banni avec succès`
    });
  } catch (error) {
    console.error('Erreur lors du bannissement:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Route pour débannir un utilisateur (admin seulement)
router.post('/:userId/unban', requireAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        message: 'Format d\'ID utilisateur invalide'
      });
    }

    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });

    if (!user) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    if (!user.is_banned) {
      return res.status(400).json({ success: false, message: 'Cet utilisateur n\'est pas banni' });
    }

    await req.db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      {
        $set: {
          is_banned: false,
          ban_reason: null,
          banned_at: null,
          banned_by: null
        }
      }
    );

    // Notification Discord (non bloquante)
    try {
      const unbanner = await req.db.collection('users').findOne(
        { _id: new ObjectId(req.user._id) },
        { projection: { global_name: 1, username: 1, bbs_name: 1 } }
      );
      const unbannerName = unbanner?.bbs_name || unbanner?.global_name || unbanner?.username || 'Inconnu';
      const unbannedName = user.bbs_name || user.global_name || user.username || 'Inconnu';
      notifyDiscord('ban', {
        action: 'unban',
        banned_by: unbannerName,
        banned_user: unbannedName,
        reason: null
      }, process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
    } catch (notifErr) {
      console.error('[users/unban] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.json({
      success: true,
      message: `${user.global_name || user.username} a été débanni avec succès`
    });
  } catch (error) {
    console.error('Erreur lors du débannissement:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

export default router;