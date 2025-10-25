import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb } from '../middleware/auth.js';

const router = express.Router();

// Middleware pour toutes les routes guildes
router.use(requireDb);

// Récupérer toutes les guildes
router.get('/', async (req, res) => {
  try {
    const guildes = await req.db.collection('guildes').find().toArray();
    guildes.sort((a, b) => a.name.localeCompare(b.name));
    res.status(200).json(guildes);
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
          global_name: 1
        }
      }
    ).toArray();

    res.json({ success: true, membres, count: membres.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

    await req.db.collection('guildes').updateOne(
      { _id: new ObjectId(guildeId) },
      { $set: { name: name.trim() } }
    );

    res.status(200).json({ success: true, message: `Guilde renommée en ${name.trim()}` });
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

export default router;