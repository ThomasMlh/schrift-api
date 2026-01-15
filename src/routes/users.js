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

    if (!decoded.is_admin) {
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
    const { guilde_id, role, search } = req.query;

    // Construire la requête de filtrage
    const query = {};

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
          guilde_id: 1,
          role: 1,
          is_admin: 1,
          last_login: 1,
          global_name: 1,
          bbs_id: 1,
          bbs_name: 1
        }
      })
      .sort({ last_login: -1 }) // Trier par dernière connexion (plus récents en premier)
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
          guilde_id: 1,
          role: 1,
          is_admin: 1,
          last_login: 1,
          global_name: 1,
          bbs_id: 1,
          bbs_name: 1
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
          is_admin: 1,
          last_login: 1,
          global_name: 1,
          guilde_id: 1,
          role: 1
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
        search: search || null
      }
    });
  } catch (error) {
    console.error('Erreur lors de la récupération des utilisateurs sans guilde:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// GET statistiques personnelles d'un joueur par user_id
router.get('/:user_id/stats', async (req, res) => {
  try {
    const { user_id } = req.params;
    const { cycle_id } = req.query;

    // Vérifier que l'utilisateur existe
    const user = await req.db.collection('users').findOne({
      $or: [
        { _id: new ObjectId(user_id) },
        { discord_id: user_id },
        { bbs_id: user_id }
      ]
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Utilisateur non trouvé'
      });
    }

    // Construire le filtre pour les scores
    const scoreFilter = {
      user_id: user._id.toString()
    };

    // Filtrer par cycle si spécifié
    if (cycle_id) {
      scoreFilter.cycle_id = cycle_id;
    }

    // Récupérer tous les scores de l'utilisateur avec les détails des rotations
    const scoresWithRotations = await req.db.collection('scores')
      .aggregate([
        { $match: scoreFilter },
        {
          $lookup: {
            from: 'rotations',
            let: { rotationId: { $toObjectId: "$rotation_id" } },
            pipeline: [
              { $match: { $expr: { $eq: ["$_id", "$$rotationId"] } } },
              {
                $project: {
                  _id: 1,
                  killer: 1,
                  attack: 1,
                  alteration: 1,
                  position: 1,
                  cycle_id: 1,
                  start_date: 1,
                  end_date: 1
                }
              }
            ],
            as: 'rotation'
          }
        },
        {
          $unwind: {
            path: "$rotation",
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $project: {
            _id: 1,
            score: 1,
            cycle_id: 1,
            rotation_id: 1,
            rotation_killer: "$rotation.killer",
            rotation_attack: "$rotation.attack",
            rotation_alteration: "$rotation.alteration",
            rotation_position: "$rotation.position",
            rotation_start_date: "$rotation.start_date",
            rotation_end_date: "$rotation.end_date",
            created_at: 1
          }
        }
      ])
      .toArray();

    if (scoresWithRotations.length === 0) {
      return res.json({
        success: true,
        data: {
          user: {
            _id: user._id,
            discord_id: user.discord_id,
            username: user.username,
            global_name: user.global_name,
            bbs_id: user.bbs_id,
            bbs_name: user.bbs_name,
            avatar: user.avatar
          },
          stats: {
            totalScores: 0,
            averageScore: 0,
            bestRotation: null,
            worstRotation: null,
            totalPoints: 0
          },
          filters: {
            cycle_id: cycle_id || null
          }
        }
      });
    }

    // Calculer les statistiques globales
    const totalScores = scoresWithRotations.length;
    const totalPoints = scoresWithRotations.reduce((sum, s) => sum + (s.score || 0), 0);
    const averageScore = Math.round(totalPoints / totalScores);

    // Grouper par rotation pour trouver la meilleure et la pire
    const rotationStats = {};
    scoresWithRotations.forEach(score => {
      if (!score.rotation_id) return;
      
      if (!rotationStats[score.rotation_id]) {
        rotationStats[score.rotation_id] = {
          rotation_id: score.rotation_id,
          rotation_killer: score.rotation_killer,
          rotation_attack: score.rotation_attack,
          rotation_alteration: score.rotation_alteration,
          rotation_position: score.rotation_position,
          cycle_id: score.cycle_id,
          scores: [],
          totalScore: 0,
          count: 0
        };
      }
      
      rotationStats[score.rotation_id].scores.push(score.score);
      rotationStats[score.rotation_id].totalScore += score.score || 0;
      rotationStats[score.rotation_id].count += 1;
    });

    // Calculer la moyenne pour chaque rotation
    const rotationAverages = Object.values(rotationStats).map(rotation => ({
      rotation_id: rotation.rotation_id,
      rotation_killer: rotation.rotation_killer,
      rotation_attack: rotation.rotation_attack,
      rotation_alteration: rotation.rotation_alteration,
      rotation_position: rotation.rotation_position,
      cycle_id: rotation.cycle_id,
      averageScore: rotation.totalScore / rotation.count,
      totalScore: rotation.totalScore,
      scoreCount: rotation.count,
      scores: rotation.scores
    }));

    // Trier pour trouver la meilleure et la pire rotation
    rotationAverages.sort((a, b) => b.averageScore - a.averageScore);

    const bestRotation = rotationAverages.length > 0 ? {
      rotation_id: rotationAverages[0].rotation_id,
      rotation_killer: rotationAverages[0].rotation_killer,
      rotation_attack: rotationAverages[0].rotation_attack,
      rotation_alteration: rotationAverages[0].rotation_alteration,
      rotation_position: rotationAverages[0].rotation_position,
      cycle_id: rotationAverages[0].cycle_id,
      averageScore: Math.round(rotationAverages[0].averageScore),
      totalScore: rotationAverages[0].totalScore,
      scoreCount: rotationAverages[0].scoreCount
    } : null;

    const worstRotation = rotationAverages.length > 0 ? {
      rotation_id: rotationAverages[rotationAverages.length - 1].rotation_id,
      rotation_killer: rotationAverages[rotationAverages.length - 1].rotation_killer,
      rotation_attack: rotationAverages[rotationAverages.length - 1].rotation_attack,
      rotation_alteration: rotationAverages[rotationAverages.length - 1].rotation_alteration,
      rotation_position: rotationAverages[rotationAverages.length - 1].rotation_position,
      cycle_id: rotationAverages[rotationAverages.length - 1].cycle_id,
      averageScore: Math.round(rotationAverages[rotationAverages.length - 1].averageScore),
      totalScore: rotationAverages[rotationAverages.length - 1].totalScore,
      scoreCount: rotationAverages[rotationAverages.length - 1].scoreCount
    } : null;

    // Trouver le meilleur score unique
    const bestScore = Math.max(...scoresWithRotations.map(s => s.score || 0));
    const bestScoreDetails = scoresWithRotations.find(s => s.score === bestScore);

    // Trouver le pire score unique
    const worstScore = Math.min(...scoresWithRotations.map(s => s.score || 0));
    const worstScoreDetails = scoresWithRotations.find(s => s.score === worstScore);

    res.json({
      success: true,
      data: {
        user: {
          _id: user._id,
          discord_id: user.discord_id,
          username: user.username,
          global_name: user.global_name,
          bbs_id: user.bbs_id,
          bbs_name: user.bbs_name,
          avatar: user.avatar,
          guilde_id: user.guilde_id,
          role: user.role
        },
        stats: {
          totalScores: totalScores,
          averageScore: averageScore,
          totalPoints: totalPoints,
          bestRotation: bestRotation,
          worstRotation: worstRotation,
          bestScore: {
            score: bestScore,
            rotation_id: bestScoreDetails?.rotation_id,
            rotation_killer: bestScoreDetails?.rotation_killer,
            rotation_attack: bestScoreDetails?.rotation_attack,
            rotation_alteration: bestScoreDetails?.rotation_alteration,
            rotation_position: bestScoreDetails?.rotation_position,
            cycle_id: bestScoreDetails?.cycle_id
          },
          worstScore: {
            score: worstScore,
            rotation_id: worstScoreDetails?.rotation_id,
            rotation_killer: worstScoreDetails?.rotation_killer,
            rotation_attack: worstScoreDetails?.rotation_attack,
            rotation_alteration: worstScoreDetails?.rotation_alteration,
            rotation_position: worstScoreDetails?.rotation_position,
            cycle_id: worstScoreDetails?.cycle_id
          },
          allRotations: rotationAverages.map(r => ({
            rotation_id: r.rotation_id,
            rotation_killer: r.rotation_killer,
            rotation_attack: r.rotation_attack,
            rotation_alteration: r.rotation_alteration,
            rotation_position: r.rotation_position,
            cycle_id: r.cycle_id,
            averageScore: Math.round(r.averageScore),
            scoreCount: r.scoreCount
          }))
        },
        filters: {
          cycle_id: cycle_id || null
        }
      }
    });

  } catch (error) {
    console.error('Erreur lors de la récupération des statistiques du joueur:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erreur serveur lors de la récupération des statistiques'
    });
  }
});

export default router;