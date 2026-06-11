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

// Classement de toutes les guildes pour un cycle
router.get('/rankings', async (req, res) => {
  try {
    const cycleId = req.query.cycle_id;

    const guildes = await req.db.collection('guildes').find({ disabled: { $ne: true } }).toArray();
    if (guildes.length === 0) return res.json({ success: true, data: [] });

    const guildIds = guildes.map(g => g._id.toString());
    const allMembres = await req.db.collection('users').find(
      { guilde_id: { $in: guildIds } },
      { projection: { _id: 1, guilde_id: 1 } }
    ).toArray();

    const membersByGuild = {};
    for (const m of allMembres) {
      if (!membersByGuild[m.guilde_id]) membersByGuild[m.guilde_id] = [];
      membersByGuild[m.guilde_id].push(m._id.toString());
    }

    const allMemberIds = allMembres.map(m => m._id.toString());
    const scoresQuery = { user_id: { $in: allMemberIds } };
    if (cycleId) scoresQuery.cycle_id = cycleId;

    const allScores = await req.db.collection('scores').find(scoresQuery, { projection: { user_id: 1, score: 1 } }).toArray();

    const scoresByMember = {};
    for (const s of allScores) {
      if (!scoresByMember[s.user_id]) scoresByMember[s.user_id] = [];
      scoresByMember[s.user_id].push(s.score || 0);
    }

    const results = guildes.map(guild => {
      const guildId = guild._id.toString();
      const guildMemberIds = membersByGuild[guildId] || [];
      const guildScores = guildMemberIds.flatMap(mid => scoresByMember[mid] || []);

      const totalScores = guildScores.length;
      const totalPoints = guildScores.reduce((s, v) => s + v, 0);
      const averageScore = totalScores > 0 ? Math.round(totalPoints / totalScores) : 0;
      const bestScore = totalScores > 0 ? Math.max(...guildScores) : 0;
      const clearCount = guildScores.filter(v => v >= 600_000_000).length;
      const clearRate = totalScores > 0 ? Math.round((clearCount / totalScores) * 10000) / 100 : 0;

      return { _id: guildId, name: guild.name, totalMembers: guildMemberIds.length, averageScore, bestScore, totalScores, totalPoints, clearRate };
    });

    results.sort((a, b) => b.averageScore - a.averageScore);
    results.forEach((g, i) => { g.rank = i + 1; });

    res.json({ success: true, data: results });
  } catch (err) {
    console.error('Error fetching guild rankings:', err);
    res.status(500).json({ success: false, error: err.message });
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
          totalPoints: 0,
          clearRate: 0
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
    const clearCount = scores.filter(s => (s.score || 0) >= 600_000_000).length;
    const clearRate = totalScores > 0 ? Math.round((clearCount / totalScores) * 100 * 100) / 100 : 0;

    const stats = {
      totalMembers: membres.length,
      averageScore,
      totalScores,
      bestScore,
      totalPoints,
      clearRate
    };

    res.json({ success: true, data: stats });
  } catch (err) {
    console.error('Error fetching guild stats:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Top membres d'une guilde pour un cycle
router.get('/:id/top-members', async (req, res) => {
  try {
    const cycleId = req.query.cycle_id;
    const limit = Math.min(parseInt(req.query.limit) || 3, 10);
    const guildeId = req.params.id;

    const membres = await req.db.collection('users').find(
      { guilde_id: guildeId },
      { projection: { _id: 1, discord_id: 1, global_name: 1, username: 1, avatar: 1 } }
    ).toArray();

    if (membres.length === 0) return res.json({ success: true, data: [] });

    const memberIds = membres.map(m => m._id.toString());
    const memberMap = Object.fromEntries(membres.map(m => [m._id.toString(), m]));

    const scoresQuery = { user_id: { $in: memberIds } };
    if (cycleId) scoresQuery.cycle_id = cycleId;

    const scores = await req.db.collection('scores').find(scoresQuery, { projection: { user_id: 1, score: 1 } }).toArray();

    const byMember = {};
    for (const s of scores) {
      if (!byMember[s.user_id]) byMember[s.user_id] = [];
      byMember[s.user_id].push(s.score || 0);
    }

    const topMembers = Object.entries(byMember).map(([userId, memberScores]) => {
      const user = memberMap[userId];
      const bestScore = Math.max(...memberScores);
      const avgScore = Math.round(memberScores.reduce((a, b) => a + b, 0) / memberScores.length);
      return { userId, username: user?.global_name || user?.username || 'Inconnu', avatar: user?.avatar, discord_id: user?.discord_id, bestScore, avgScore, totalScores: memberScores.length };
    });

    topMembers.sort((a, b) => b.bestScore - a.bestScore);
    res.json({ success: true, data: topMembers.slice(0, limit) });
  } catch (err) {
    console.error('Error fetching guild top members:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Distribution des scores d'une guilde pour un cycle
router.get('/:id/score-distribution', async (req, res) => {
  try {
    const cycleId = req.query.cycle_id;
    const guildeId = req.params.id;

    const membres = await req.db.collection('users').find({ guilde_id: guildeId }, { projection: { _id: 1 } }).toArray();
    const memberIds = membres.map(m => m._id.toString());

    const scoresQuery = { user_id: { $in: memberIds } };
    if (cycleId) scoresQuery.cycle_id = cycleId;

    const scores = await req.db.collection('scores').find(scoresQuery, { projection: { score: 1 } }).toArray();

    const buckets = [
      { label: '< 300M', min: 0, max: 300_000_000, count: 0 },
      { label: '300M–500M', min: 300_000_000, max: 500_000_000, count: 0 },
      { label: '500M–600M', min: 500_000_000, max: 600_000_000, count: 0 },
      { label: '600M–800M', min: 600_000_000, max: 800_000_000, count: 0 },
      { label: '800M–1B', min: 800_000_000, max: 1_000_000_000, count: 0 },
      { label: '≥ 1B', min: 1_000_000_000, max: Infinity, count: 0 },
    ];

    for (const s of scores) {
      const val = s.score || 0;
      const bucket = buckets.find(b => val >= b.min && val < b.max);
      if (bucket) bucket.count++;
    }

    res.json({ success: true, data: buckets.map(b => ({ label: b.label, count: b.count })) });
  } catch (err) {
    console.error('Error fetching guild score distribution:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Évolution d'une guilde sur les derniers cycles
router.get('/:id/evolution', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 6, 12);
    const guildeId = req.params.id;

    const membres = await req.db.collection('users').find({ guilde_id: guildeId }, { projection: { _id: 1 } }).toArray();
    const memberIds = membres.map(m => m._id.toString());

    const allCycles = await req.db.collection('cycles').find({}).toArray();

    const parseDate = (s) => {
      if (!s) return 0;
      const parts = s.split('/');
      if (parts.length !== 3) return 0;
      return new Date(parts[2], parts[1] - 1, parts[0]).getTime();
    };

    allCycles.sort((a, b) => parseDate(b.rotations?.[0]?.start_date) - parseDate(a.rotations?.[0]?.start_date));
    const recentCycles = allCycles.slice(0, limit).reverse();

    const cycleIds = recentCycles.map(c => c._id.toString());
    const allScores = await req.db.collection('scores').find(
      { user_id: { $in: memberIds }, cycle_id: { $in: cycleIds } },
      { projection: { user_id: 1, cycle_id: 1, score: 1 } }
    ).toArray();

    const scoresByCycle = {};
    for (const s of allScores) {
      if (!scoresByCycle[s.cycle_id]) scoresByCycle[s.cycle_id] = [];
      scoresByCycle[s.cycle_id].push(s.score || 0);
    }

    const results = recentCycles.map(cycle => {
      const cycleId = cycle._id.toString();
      const cycleScores = scoresByCycle[cycleId] || [];
      const totalScores = cycleScores.length;
      const totalPoints = cycleScores.reduce((s, v) => s + v, 0);
      const averageScore = totalScores > 0 ? Math.round(totalPoints / totalScores) : 0;
      const clearCount = cycleScores.filter(v => v >= 600_000_000).length;
      const clearRate = totalScores > 0 ? Math.round((clearCount / totalScores) * 10000) / 100 : 0;
      return { cycleId, cycleName: cycle.name, cycleYear: cycle.year, averageScore, totalScores, clearRate };
    });

    res.json({ success: true, data: results });
  } catch (err) {
    console.error('Error fetching guild evolution:', err);
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