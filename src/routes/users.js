import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb, requireAdmin, validateObjectIdParam } from '../middleware/auth.js';
import { notifyDiscord } from '../utils/notifyDiscord.js';
import { getUserStats } from '../services/userStats.js';
import { getUserDisplayName } from '../utils/nameMatching.js';
import { parsePaginationParams, buildPaginationMeta } from '../utils/pagination.js';
import { USER_FULL, USER_DISPLAY } from '../utils/projections.js';

const router = express.Router();

// Middleware pour toutes les routes users
router.use(requireDb);

// Route pour récupérer tous les utilisateurs avec pagination (accessible à tous)
router.get('/', async (req, res) => {
  try {
    const { page, limit, skip } = parsePaginationParams(req.query);

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
      .find(query, { projection: USER_FULL })
      .sort({ last_login: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const totalCount = await req.db.collection('users').countDocuments(query);

    res.json({
      success: true,
      users,
      pagination: buildPaginationMeta(page, limit, totalCount, users.length),
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
    const { page, limit, skip } = parsePaginationParams(req.query);

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
      .find(query, { projection: USER_FULL })
      .sort({ bbs_name: 1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    const totalCount = await req.db.collection('users').countDocuments(query);

    res.json({
      success: true,
      users,
      pagination: buildPaginationMeta(page, limit, totalCount, users.length),
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
router.get('/:userId', validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await req.db.collection('users').findOne(
      { _id: new ObjectId(userId) },
      { projection: USER_FULL }
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

router.patch('/:userId', validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId } = req.params;
    const updates = req.body;

    const result = await req.db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      { $set: updates }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    const updatedUser = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });

    res.json({ success: true, message: `${getUserDisplayName(updatedUser)} mis à jour avec succès` });
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
router.put('/:userId/guild', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
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

    const user = await req.db.collection('users').findOne({ _id: new ObjectId(userId) });

    res.json({ success: true, message: `${getUserDisplayName(user, 'Utilisateur')} déplacé vers la nouvelle guilde` });
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
router.post('/:userId/ban', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;
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
        { projection: USER_DISPLAY }
      );
      const bannerName = getUserDisplayName(banner);
      const bannedName = getUserDisplayName(user);
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
      message: `${getUserDisplayName(user)} a été banni avec succès`
    });
  } catch (error) {
    console.error('Erreur lors du bannissement:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Route pour débannir un utilisateur (admin seulement)
router.post('/:userId/unban', requireAdmin, validateObjectIdParam('userId', "Format d'ID utilisateur invalide"), async (req, res) => {
  try {
    const { userId } = req.params;
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
        { projection: USER_DISPLAY }
      );
      const unbannerName = getUserDisplayName(unbanner);
      const unbannedName = getUserDisplayName(user);
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
      message: `${getUserDisplayName(user)} a été débanni avec succès`
    });
  } catch (error) {
    console.error('Erreur lors du débannissement:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

export default router;