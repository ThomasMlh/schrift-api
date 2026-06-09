import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb, requireAdmin } from '../middleware/auth.js';
import { getUserDisplayName } from '../utils/nameMatching.js';
import { notifyDiscord } from '../utils/notifyDiscord.js';

const router = express.Router();

// Middleware pour toutes les routes guildes
router.use(requireDb);

// Récupérer toutes les guildes
router.get('/', async (req, res) => {
  try {
    const includeDisabled = req.query.include_disabled === 'true';
    const filter = includeDisabled ? {} : { disabled: { $ne: true } };
    const guildes = await req.db.collection('guildes').find(filter).toArray();
    guildes.sort((a, b) => a.name.localeCompare(b.name));
    res.status(200).json(guildes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Récupérer une guilde par ID
router.get('/:id', async (req, res) => {
  try {
    const guilde = await req.db.collection('guildes').findOne({ _id: new ObjectId(req.params.id) });
    if (!guilde) {
      return res.status(404).json({ success: false, message: 'Guilde non trouvée' });
    }
    res.json(guilde);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Récupérer les membres d'une guilde
router.get('/:id/membres', async (req, res) => {
  try {
    const guildeId = req.params.id;
        
    // Récupérer les membres depuis la collection users
    const membres = await req.db.collection('users').find(
      { guilde_id: guildeId },
      {
        projection: {
          _id: 1,
          discord_id: 1,
          username: 1,
          avatar: 1,
          role: 1,
          is_admin: 1,
          last_login: 1,
          global_name: 1,
          bbs_id: 1,
          bbs_name: 1
        }
      }
    ).toArray();

    res.json({ success: true, data: membres, count: membres.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Récupérer les statistiques d'une guilde
router.get('/:id/stats', async (req, res) => {
  try {
    const guildeId = req.params.id;
    const cycleId = req.query.cycle_id;

    // Vérifier que la guilde existe
    const guilde = await req.db.collection('guildes').findOne({ _id: new ObjectId(guildeId) });
    if (!guilde) {
      return res.status(404).json({ success: false, message: 'Guilde non trouvée' });
    }

    // Récupérer tous les membres de la guilde
    const membres = await req.db.collection('users')
      .find({ guilde_id: guildeId })
      .toArray();

    if (membres.length === 0) {
      return res.json({
        success: true,
        data: {
          totalMembers: 0,
          averageScore: 0,
          totalScores: 0,
          bestScore: 0,
          totalPoints: 0
        }
      });
    }

    // Créer un tableau des IDs des membres
    const membersIds = membres.map(m => m._id.toString());

    // Construire la requête pour les scores
    const scoresQuery = { user_id: { $in: membersIds } };
    if (cycleId) {
      scoresQuery.cycle_id = cycleId;
    }

    // Récupérer tous les scores des membres
    const scores = await req.db.collection('scores')
      .find(scoresQuery)
      .toArray();

    // Calculer les statistiques
    const totalScores = scores.length;
    const totalPoints = scores.reduce((sum, score) => sum + (score.score || 0), 0);
    const averageScore = totalScores > 0 ? Math.round(totalPoints / totalScores) : 0;
    const bestScore = totalScores > 0 ? Math.max(...scores.map(s => s.score || 0)) : 0;

    const stats = {
      totalMembers: membres.length,
      averageScore,
      totalScores,
      bestScore,
      totalPoints
    };

    res.json({ success: true, data: stats });
  } catch (err) {
    console.error('Error fetching guild stats:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Ajouter une guilde
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: 'Le nom de la guilde est requis' });
    }

    // Vérifier si une guilde avec ce nom existe déjà
    const existingGuilde = await req.db.collection('guildes').findOne({
      name: { $regex: new RegExp(`^${name.trim()}$`, 'i') } // Insensible à la casse
    });

    if (existingGuilde) {
      return res.status(409).json({
        success: false,
        message: 'Une guilde avec ce nom existe déjà'
      });
    }

    const result = await req.db.collection('guildes').insertOne({
      ...req.body,
      name: name.trim() // Nettoyer le nom
    });

    res.status(200).json({
      success: true,
      insertedId: result.insertedId,
      message: `Guilde ${name.trim()} ajoutée avec succès`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Renommer une guilde
router.put('/:id', async (req, res) => {
  try {
    const { name } = req.body;
    const guildeId = req.params.id;

    if (!name || name.trim() === '') {
      return res.status(400).json({ success: false, message: 'Le nom de la guilde est requis' });
    }

    // Vérifier si une autre guilde avec ce nom existe déjà (excluant la guilde actuelle)
    const existingGuilde = await req.db.collection('guildes').findOne({
      name: { $regex: new RegExp(`^${name.trim()}$`, 'i') },
      _id: { $ne: new ObjectId(guildeId) }
    });

    if (existingGuilde) {
      return res.status(409).json({
        success: false,
        message: 'Une autre guilde avec ce nom existe déjà'
      });
    }

    const updateFields = { name: name.trim() };
    const { discord_channel_id } = req.body;
    if (discord_channel_id !== undefined) {
      updateFields.discord_channel_id = discord_channel_id;
    }

    await req.db.collection('guildes').updateOne(
      { _id: new ObjectId(guildeId) },
      { $set: updateFields }
    );

    res.status(200).json({ success: true, message: `Guilde renommée en ${name.trim()}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Activer/Désactiver une guilde
router.patch('/:id/toggle-disable', requireAdmin, async (req, res) => {
  try {
    const guildeId = req.params.id;
    const guilde = await req.db.collection('guildes').findOne({ _id: new ObjectId(guildeId) });
    if (!guilde) {
      return res.status(404).json({ success: false, message: 'Guilde non trouvée' });
    }

    const newDisabledState = !guilde.disabled;

    // Si on désactive la guilde, retirer tous les membres
    if (newDisabledState) {
      await req.db.collection('users').updateMany(
        { guilde_id: guildeId },
        { $set: { guilde_id: null, role: null } }
      );
    }

    await req.db.collection('guildes').updateOne(
      { _id: new ObjectId(guildeId) },
      { $set: { disabled: newDisabledState } }
    );

    const action = newDisabledState ? 'désactivée' : 'réactivée';
    res.status(200).json({
      success: true,
      message: `Guilde ${guilde.name} ${action} avec succès`,
      disabled: newDisabledState
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Supprimer une guilde
router.delete('/:id', async (req, res) => {
  try {
    const guilde = await req.db.collection('guildes').findOne({ _id: new ObjectId(req.params.id) });
    if (!guilde) {
      return res.status(404).json({ success: false, message: 'Guilde non trouvée' });
    }

    await req.db.collection('guildes').deleteOne({ _id: new ObjectId(req.params.id) });
    res.status(200).json({ success: true, message: `Guilde ${guilde.name} supprimée avec succès` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assigner un utilisateur à une guilde avec un rôle
router.post('/:id/assign-member', async (req, res) => {
  try {
    const guildeId = req.params.id;
    const { userId, role } = req.body;

    if (!userId || !role) {
      return res.status(400).json({ 
        success: false, 
        message: 'userId et role sont requis' 
      });
    }

    // Vérifier les contraintes de rôle
    if (role === 'chef') {
      const existingChef = await req.db.collection('users').findOne({ 
        guilde_id: guildeId, 
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
        guilde_id: guildeId, 
        role: 'sous-chef',
      });
      if (sousChefCount >= 2) {
        return res.status(400).json({ 
          success: false, 
          message: 'Il ne peut y avoir que deux sous-chefs dans une guilde' 
        });
      }
    }

    // Mettre à jour l'utilisateur
    const result = await req.db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      { $set: { guilde_id: guildeId, role: role } }
    );

    const user = await req.db.collection('users').findOne(
      { _id: new ObjectId(userId) }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    res.json({ success: true, message: `${user.global_name || 'Utilisateur'} assigné à la guilde avec succès` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retirer un membre d'une guilde
router.delete('/:id/members/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const result = await req.db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      { $set: { guilde_id: null, role: null } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    res.json({ success: true, message: 'Utilisateur retiré de la guilde' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retirer un membre d'une guilde
router.delete('/:guildeId/membres/:userId', async (req, res) => {
  try {
    const guildeId = req.params.guildeId;
    const userId = req.params.userId;

    // Vérifier que l'utilisateur existe et est dans cette guilde
    const user = await req.db.collection('users').findOne({ 
      _id: new ObjectId(userId),
      guilde_id: guildeId 
    });
    
    if (!user) {
      return res.status(404).json({ 
        success: false, 
        message: 'Utilisateur non trouvé dans cette guilde' 
      });
    }

    // Retirer l'utilisateur de la guilde
    const result = await req.db.collection('users').updateOne(
      { _id: new ObjectId(userId) },
      { 
        $set: { 
          guilde_id: null, 
          role: null 
        } 
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Utilisateur non trouvé' });
    }

    res.json({ 
      success: true, 
      message: `${user.global_name || 'Utilisateur'} retiré de la guilde avec succès` 
    });
  } catch (err) {
    console.error('Erreur lors de la suppression du membre:', err);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Ajouter un membre à une guilde
router.post('/:id/membres', async (req, res) => {
  try {
    const guildeId = req.params.id;
    const role = req.body.role || 'membre';

    // Vérifications si le membre existe
    const user = await req.db.collection('users').findOne({ guilde_id: guildeId, discord_id: req.body.discord_id });
    if (user) {
      return res.status(400).json({ success: false, message: 'Le membre existe déjà dans cette guilde' });
    }

    // Vérifications des contraintes de rôle
    if (role === 'chef') {
      const chefCount = await req.db.collection('users').countDocuments({ guilde_id: guildeId, role: 'chef' });
      if (chefCount >= 1) {
        return res.status(400).json({ success: false, message: 'Il ne peut y avoir qu\'un seul chef dans une guilde' });
      }
    }

    if (role === 'sous-chef') {
      const sousChefCount = await req.db.collection('users').countDocuments({ guilde_id: guildeId, role: 'sous-chef' });
      if (sousChefCount >= 2) {
        return res.status(400).json({ success: false, message: 'Il ne peut y avoir que deux sous-chefs dans une guilde' });
      }
    }

    const membre = { ...req.body, guilde_id: guildeId };
    const result = await req.db.collection('users').insertOne(membre);
    res.status(201).json({ success: true, message: `${user.global_name || 'Membre'} ajouté avec succès` });
  } catch (err) {
    console.error('Erreur lors de l\'ajout du membre:', err);
    res.status(500).json({ success: false, message: 'Erreur serveur' });
  }
});

// Exécuter un draft : retirer puis réassigner des joueurs en bulk
router.post('/draft', requireAdmin, async (req, res) => {
  try {
    const { moves } = req.body;

    if (!Array.isArray(moves) || moves.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Un tableau de mouvements est requis'
      });
    }

    // Valider chaque mouvement
    for (const move of moves) {
      if (!move.userId) {
        return res.status(400).json({
          success: false,
          message: 'Chaque mouvement doit contenir userId'
        });
      }
      if (!ObjectId.isValid(move.userId)) {
        return res.status(400).json({
          success: false,
          message: `ID utilisateur invalide: ${move.userId}`
        });
      }
      if (move.toGuildId && !ObjectId.isValid(move.toGuildId)) {
        return res.status(400).json({
          success: false,
          message: `ID guilde invalide: ${move.toGuildId}`
        });
      }
    }

    // Vérifier que toutes les guildes cibles existent (hors retraits)
    const targetGuildIds = [...new Set(moves.filter(m => m.toGuildId).map(m => m.toGuildId))];
    let guilds = [];
    if (targetGuildIds.length > 0) {
      guilds = await req.db.collection('guildes').find({
        _id: { $in: targetGuildIds.map(id => new ObjectId(id)) }
      }).toArray();

      if (guilds.length !== targetGuildIds.length) {
        return res.status(400).json({
          success: false,
          message: 'Une ou plusieurs guildes cibles n\'existent pas'
        });
      }
    }

    // Vérifier que tous les utilisateurs existent
    const userIds = moves.map(m => m.userId);
    const users = await req.db.collection('users').find({
      _id: { $in: userIds.map(id => new ObjectId(id)) }
    }).toArray();

    if (users.length !== userIds.length) {
      return res.status(400).json({
        success: false,
        message: 'Un ou plusieurs utilisateurs n\'existent pas'
      });
    }

    // Étape 1 : Retirer tous les joueurs concernés de leur guilde
    const userObjectIds = userIds.map(id => new ObjectId(id));
    await req.db.collection('users').updateMany(
      { _id: { $in: userObjectIds } },
      { $set: { guilde_id: null, role: null } }
    );

    // Étape 2 : Calculer les effectifs finaux par guilde pour vérifier la limite de 20
    // Compter les membres actuels (hors ceux du draft)
    const guildCounts = {};
    for (const guildId of targetGuildIds) {
      const count = await req.db.collection('users').countDocuments({
        guilde_id: guildId,
        _id: { $nin: userObjectIds }
      });
      guildCounts[guildId] = count;
    }

    // Vérifier que chaque guilde ne dépassera pas 20 membres (ignorer les retraits)
    for (const move of moves) {
      if (!move.toGuildId) continue;
      guildCounts[move.toGuildId] = (guildCounts[move.toGuildId] || 0) + 1;
      if (guildCounts[move.toGuildId] > 20) {
        // Rollback : remettre les users dans leur guilde d'origine
        const userMap = {};
        users.forEach(u => { userMap[u._id.toString()] = u; });
        for (const m of moves) {
          const originalUser = userMap[m.userId];
          if (originalUser && originalUser.guilde_id) {
            await req.db.collection('users').updateOne(
              { _id: new ObjectId(m.userId) },
              { $set: { guilde_id: originalUser.guilde_id, role: originalUser.role } }
            );
          }
        }
        const guildName = guilds.find(g => g._id.toString() === move.toGuildId)?.name || move.toGuildId;
        return res.status(400).json({
          success: false,
          message: `La guilde ${guildName} dépasserait la limite de 20 membres`
        });
      }
    }

    // Étape 3 : Réassigner chaque joueur dans sa nouvelle guilde (ou laisser sans guilde)
    const results = [];
    for (const move of moves) {
      if (move.toGuildId) {
        const role = move.role || 'membre';
        await req.db.collection('users').updateOne(
          { _id: new ObjectId(move.userId) },
          { $set: { guilde_id: move.toGuildId, role } }
        );
      }
      // Si toGuildId est null, le joueur reste sans guilde (déjà retiré à l'étape 1)
      const user = users.find(u => u._id.toString() === move.userId);
      results.push({
        userId: move.userId,
        username: getUserDisplayName(user),
        toGuildId: move.toGuildId || null,
        toGuildName: move.toGuildId
          ? (guilds.find(g => g._id.toString() === move.toGuildId)?.name || 'Inconnue')
          : 'Aucune guilde'
      });
    }

    res.json({
      success: true,
      message: `${moves.length} joueur(s) déplacé(s) avec succès`,
      results
    });

    // Notifications Discord par guilde concernée (non bloquant)
    try {
      const userMap = {};
      users.forEach(u => { userMap[u._id.toString()] = u; });

      // Récupérer les guildes sources (pas forcément dans `guilds` qui ne contient que les cibles)
      const sourceGuildeIds = [...new Set(users.map(u => u.guilde_id).filter(Boolean))];
      const missingIds = sourceGuildeIds.filter(id => !guilds.find(g => g._id.toString() === id));
      const allGuildes = [...guilds];
      if (missingIds.length > 0) {
        const sourceGuildes = await req.db.collection('guildes').find({
          _id: { $in: missingIds.map(id => new ObjectId(id)) }
        }).toArray();
        allGuildes.push(...sourceGuildes);
      }

      const guildeMap = {};
      for (const g of allGuildes) {
        guildeMap[g._id.toString()] = { name: g.name, discord_channel_id: g.discord_channel_id, moves: [] };
      }

      for (const result of results) {
        const user = userMap[result.userId];
        const fromGuildeId = user?.guilde_id || null;
        const toGuildeId = result.toGuildId;

        const fromGuildName = fromGuildeId ? (guildeMap[fromGuildeId]?.name || 'Guilde inconnue') : 'Aucune guilde';
        const toGuildName = toGuildeId ? (guildeMap[toGuildeId]?.name || 'Guilde inconnue') : 'Aucune guilde';

        if (fromGuildeId && guildeMap[fromGuildeId]) {
          guildeMap[fromGuildeId].moves.push({
            username: result.username,
            fromGuildName,
            toGuildName,
            direction: 'départ',
          });
        }
        if (toGuildeId && guildeMap[toGuildeId]) {
          guildeMap[toGuildeId].moves.push({
            username: result.username,
            fromGuildName,
            toGuildName,
            direction: 'arrivée',
          });
        }
      }

      await Promise.allSettled(
        Object.values(guildeMap)
          .filter(g => g.moves.length > 0)
          .map(g => notifyDiscord('draft', { guild_name: g.name, moves: g.moves }, g.discord_channel_id || undefined))
      );
    } catch (notifErr) {
      console.error('[draft] Erreur lors des notifications Discord:', notifErr.message);
    }
  } catch (err) {
    console.error('Erreur lors de l\'exécution du draft:', err);
    res.status(500).json({ success: false, message: 'Erreur serveur lors du draft' });
  }
});

export default router;