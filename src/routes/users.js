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
        { bbs_name: { $regex: searchTerm, $options: 'i' } }
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

// GET podium des joueurs par cycle
router.get('/podium', async (req, res) => {
  try {
    const { cycle_id, guild_id } = req.query;

    // Validation du cycle_id obligatoire
    if (!cycle_id) {
      return res.status(400).json({
        success: false,
        message: 'Le paramètre cycle_id est obligatoire'
      });
    }

    // Construction du pipeline d'agrégation
    const matchStage = {
      cycle_id: cycle_id
    };

    // Ajouter le filtre guilde si spécifié
    if (guild_id) {
      matchStage.guild_id = guild_id;
    }

    const pipeline = [
      // Étape 1: Filtrer les scores par cycle (et guilde si spécifiée)
      {
        $match: matchStage
      },
      // Étape 2: Grouper par user_id pour calculer la moyenne des scores
      {
        $group: {
          _id: "$user_id",
          averageScore: { $avg: "$score" },
          totalScores: { $sum: 1 } // Compter le nombre de scores pour information
        }
      }
    ];

    // Debug: Vérifier les données après groupement
    const scoresGrouped = await req.db.collection('scores')
      .aggregate(pipeline)
      .toArray();

    // Continuer avec la jointure
    const pipelineWithJoin = [
      ...pipeline,
      // Étape 3: Joindre avec la collection users pour récupérer les informations utilisateur
      {
        $lookup: {
          from: 'users',
          let: { userId: "$_id" },
          pipeline: [
            { 
              $match: { 
                $expr: { 
                  $or: [
                    { $eq: [{ $toString: "$_id" }, "$$userId"] }
                  ]
                }
              }
            },
            {
              $project: {
                discord_id: 1,
                global_name: 1,
                bbs_name: 1,
                avatar: 1
              }
            }
          ],
          as: 'user'
        }
      },
      // Étape 4: Décomposer le tableau user (mais garder ceux sans user aussi pour debug)
      {
        $addFields: {
          hasUser: { $gt: [{ $size: "$user" }, 0] }
        }
      },
      // Étape 5: Projeter les champs finaux
      {
        $project: {
          _id: 0,
          user_id: "$_id",
          bbs_name: { $arrayElemAt: ["$user.bbs_name", 0] },
          discord_id: { $arrayElemAt: ["$user.discord_id", 0] },
          global_name: { $arrayElemAt: ["$user.global_name", 0] },
          averageScore: { $round: ["$averageScore", 2] }, // Arrondir à 2 décimales
          avatar: { $arrayElemAt: ["$user.avatar", 0] },
          totalScores: 1,
          hasUser: 1
        }
      },
      // Étape 6: Trier par moyenne décroissante (du plus grand au plus petit)
      {
        $sort: { averageScore: -1 }
      },
      // Étape 7: Limiter aux premiers résultats (10 pour global, 5 pour guilde spécifique)
      {
        $limit: guild_id ? 5 : 10
      }
    ];

    const podium = await req.db.collection('scores')
      .aggregate(pipelineWithJoin)
      .toArray();

    // Ajouter les positions dans le podium
    const podiumWithRank = podium.map((player, index) => ({
      rank: index + 1,
      ...player
    }));

    res.json({
      success: true,
      podium: podiumWithRank,
      filters: {
        cycle_id: cycle_id,
        guild_id: guild_id || null
      },
      meta: {
        totalPlayers: podium.length,
        cycleId: cycle_id,
        guildSpecific: !!guild_id
      }
    });

  } catch (error) {
    console.error('Erreur lors de la création du podium:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erreur serveur lors de la création du podium'
    });
  }
});

// GET podium complet des joueurs par cycle_name et rotation_id
router.get('/podium/full', async (req, res) => {
  try {
    const { cycle_name, rotation_id, guild_name, page = 1, limit = 50 } = req.query;

    // Validation des paramètres obligatoires
    if (!cycle_name) {
      return res.status(400).json({
        success: false,
        message: 'Le paramètre cycle_name est obligatoire'
      });
    }
    
    // Validation et conversion des paramètres de pagination
    const pageNumber = Math.max(1, parseInt(page, 10) || 1);
    const limitNumber = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (pageNumber - 1) * limitNumber;

    // Rechercher le cycle par son nom
    const cycle = await req.db.collection('cycles').findOne({
      name: cycle_name
    });

    if (!cycle) {
      return res.status(404).json({
        success: false,
        message: `Cycle avec le nom "${cycle_name}" non trouvé`
      });
    }

    // Vérifier que la rotation_id existe dans ce cycle (si spécifiée)
    if (rotation_id) {
      const rotationExists = cycle.rotations.some(
        (rotation) => rotation._id.toString() === rotation_id
      );

      if (!rotationExists) {
        return res.status(404).json({
          success: false,
          message: `Rotation avec l'ID "${rotation_id}" non trouvée dans le cycle "${cycle_name}"`
        });
      }
    }

    // Si guild_name est spécifié, rechercher la guilde correspondante
    let guildId = null;
    if (guild_name && guild_name.trim()) {
      const guild = await req.db.collection('guildes').findOne({
        name: guild_name.trim()
      });

      if (!guild) {
        return res.status(404).json({
          success: false,
          message: `Guilde avec le nom "${guild_name}" non trouvée`
        });
      }

      guildId = guild._id.toString();
    }

    // Construction du pipeline d'agrégation pour les scores de cette rotation spécifique
    const matchStage = {
      cycle_id: cycle._id.toString()
    };

    // Ajouter le filtre rotation si spécifié
    if (rotation_id) {
      matchStage.rotation_id = rotation_id;
    }

    // Ajouter le filtre guilde si spécifié
    if (guildId) {
      matchStage.guild_id = guildId;
    }

    let pipelineForRanking;
    
    if (rotation_id) {
      // Pipeline pour une rotation spécifique (scores individuels)
      pipelineForRanking = [
        // Étape 1: Filtrer les scores par cycle et rotation (et guilde si spécifiée)
        {
          $match: matchStage
        },
        // Étape 2: Joindre avec la collection users pour récupérer les informations utilisateur
        {
          $lookup: {
            from: 'users',
            let: { userId: "$user_id" },
            pipeline: [
              { 
                $match: { 
                  $expr: { 
                    $or: [
                      { $eq: [{ $toString: "$_id" }, "$$userId"] },
                      { $eq: ["$discord_id", "$$userId"] }
                    ]
                  }
                }
              },
              {
                $project: {
                  discord_id: 1,
                  global_name: 1,
                  bbs_name: 1,
                  avatar: 1
                }
              }
            ],
            as: 'user'
          }
        },
        // Étape 3: Ajouter info sur la présence d'utilisateur
        {
          $addFields: {
            hasUser: { $gt: [{ $size: "$user" }, 0] }
          }
        },
        // Étape 4: Projeter les champs finaux avec score individuel
        {
          $project: {
            _id: 0,
            user_id: "$user_id",
            bbs_name: { $arrayElemAt: ["$user.bbs_name", 0] },
            discord_id: { $arrayElemAt: ["$user.discord_id", 0] },
            global_name: { $arrayElemAt: ["$user.global_name", 0] },
            score: "$score", // Score individuel pour cette rotation
            raw_score: "$raw_score",
            is_differential: "$is_differential",
            avatar: { $arrayElemAt: ["$user.avatar", 0] },
            hasUser: 1
          }
        },
        // Étape 5: Trier par score décroissant (du plus grand au plus petit)
        {
          $sort: { score: -1 }
        }
      ];
    } else {
      // Pipeline pour tout le cycle (moyennes des scores)
      pipelineForRanking = [
        // Étape 1: Filtrer les scores par cycle (et guilde si spécifiée)
        {
          $match: matchStage
        },
        // Étape 2: Grouper par user_id pour calculer la moyenne des scores
        {
          $group: {
            _id: "$user_id",
            averageScore: { $avg: "$score" },
            totalScores: { $sum: 1 }, // Compter le nombre de scores pour information
            totalRawScore: { $sum: "$raw_score" }
          }
        },
        // Étape 3: Joindre avec la collection users pour récupérer les informations utilisateur
        {
          $lookup: {
            from: 'users',
            let: { userId: "$_id" },
            pipeline: [
              { 
                $match: { 
                  $expr: { 
                    $or: [
                      { $eq: [{ $toString: "$_id" }, "$$userId"] },
                      { $eq: ["$discord_id", "$$userId"] }
                    ]
                  }
                }
              },
              {
                $project: {
                  discord_id: 1,
                  global_name: 1,
                  bbs_name: 1,
                  avatar: 1
                }
              }
            ],
            as: 'user'
          }
        },
        // Étape 4: Ajouter info sur la présence d'utilisateur
        {
          $addFields: {
            hasUser: { $gt: [{ $size: "$user" }, 0] }
          }
        },
        // Étape 5: Projeter les champs finaux avec moyenne
        {
          $project: {
            _id: 0,
            user_id: "$_id",
            bbs_name: { $arrayElemAt: ["$user.bbs_name", 0] },
            discord_id: { $arrayElemAt: ["$user.discord_id", 0] },
            global_name: { $arrayElemAt: ["$user.global_name", 0] },
            averageScore: { $round: ["$averageScore", 2] }, // Moyenne arrondie à 2 décimales
            totalScores: 1,
            totalRawScore: 1,
            avatar: { $arrayElemAt: ["$user.avatar", 0] },
            hasUser: 1
          }
        },
        // Étape 6: Trier par moyenne décroissante (du plus grand au plus petit)
        {
          $sort: { averageScore: -1 }
        }
      ];
    }

    // Exécuter le pipeline complet pour calculer les ranks (sans pagination)
    const allResults = await req.db.collection('scores').aggregate(pipelineForRanking).toArray();
    
    // Calculer les ranks en tenant compte des égalités
    let currentRank = 1;
    let previousScore = null;

    const resultsWithRank = allResults.map((player, index) => {
      // Utiliser le bon champ selon le type de podium
      const scoreToCompare = rotation_id ? player.score : player.averageScore;
      
      if (previousScore !== null && scoreToCompare !== previousScore) {
        // Le score a changé, mettre à jour le rank
        currentRank = index + 1;
      }
      
      previousScore = scoreToCompare;
      
      return {
        rank: currentRank,
        ...player
      };
    });

    // Appliquer la pagination sur les résultats avec rank
    const totalCount = resultsWithRank.length;
    const startIndex = skip;
    const endIndex = skip + limitNumber;
    const podiumWithRank = resultsWithRank.slice(startIndex, endIndex);

    const totalPages = Math.ceil(totalCount / limitNumber);

    // Récupérer les informations de la rotation pour l'affichage (si spécifiée)
    const rotationInfo = rotation_id ? cycle.rotations.find(r => r._id.toString() === rotation_id) : null;

    // Calculer la moyenne générale des scores pour cette rotation (si spécifiée)
    let overallAverageScore = null;
    if (rotation_id && allResults.length > 0) {
      const totalScore = allResults.reduce((sum, player) => sum + (player.score || 0), 0);
      overallAverageScore = Math.round((totalScore / allResults.length) * 100) / 100; // Arrondi à 2 décimales
    }

    res.json({
      success: true,
      data: podiumWithRank,
      pagination: {
        currentPage: pageNumber,
        totalPages,
        totalCount,
        hasNextPage: pageNumber < totalPages,
        hasPrevPage: pageNumber > 1,
        itemsPerPage: limitNumber,
        itemsOnPage: podiumWithRank.length
      },
      filters: {
        cycle_name: cycle_name,
        cycle_id: cycle._id.toString(),
        rotation_id: rotation_id || null,
        guild_name: guild_name || null
      },
      meta: {
        totalPlayers: totalCount,
        cycleName: cycle_name,
        rotationInfo: rotationInfo,
        guildSpecific: !!guild_name,
        fullPodium: true,
        podiumType: rotation_id ? 'individual_scores' : 'average_scores', // Indiquer le type de podium
        ...(rotation_id && overallAverageScore !== null && { averageScore: overallAverageScore }) // Ajouter moyenne générale si rotation spécifique
      }
    });

  } catch (error) {
    console.error('Erreur lors de la création du podium complet:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Erreur serveur lors de la création du podium complet'
    });
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

export default router;