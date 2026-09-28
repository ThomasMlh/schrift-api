import express from 'express';
import { ObjectId } from 'mongodb';
import { requireDb } from '../middleware/auth.js';
import { notifyDiscord } from '../utils/notifyDiscord.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// Middleware pour toutes les routes membres
router.use(requireDb);

// Récupérer tous les membres
router.get('/', async (req, res) => {
  try {
    const membres = await req.db.collection('membres').find().toArray();
    res.json(membres);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Récupérer un membre par ID
router.get('/:id', async (req, res) => {
  try {
    const membre = await req.db.collection('membres').findOne({ _id: new ObjectId(req.params.id) });
    if (!membre) {
      return res.status(404).json({ success: false, message: 'Membre non trouvé' });
    }
    res.json(membre);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Changer le rôle d'un membre
router.put('/:id/role', async (req, res) => {
  try {
    const memberId = req.params.id;
    const newRole = req.body.role;

    if (!newRole) return res.status(400).json({ success: false, message: 'Role requis' });

    const member = await req.db.collection('membres').findOne({ _id: new ObjectId(memberId) });
    if (!member) return res.status(404).json({ success: false, message: 'Membre non trouvé' });

    const guildeId = member.guilde_id;

    // Vérifier contraintes si on veut passer en chef ou sous-chef
    if (newRole === 'chef') {
      const chefCount = await req.db.collection('membres').countDocuments({ 
        guilde_id: guildeId, 
        role: 'chef', 
        _id: { $ne: new ObjectId(memberId) } 
      });
      if (chefCount >= 1) {
        return res.status(400).json({ success: false, message: 'Il ne peut y avoir qu\'un seul chef dans une guilde' });
      }
    }

    if (newRole === 'sous-chef') {
      const sousChefCount = await req.db.collection('membres').countDocuments({ 
        guilde_id: guildeId, 
        role: 'sous-chef', 
        _id: { $ne: new ObjectId(memberId) } 
      });
      if (sousChefCount >= 2) {
        return res.status(400).json({ success: false, message: 'Il ne peut y avoir que deux sous-chefs dans une guilde' });
      }
    }

    await req.db.collection('membres').updateOne(
      { _id: new ObjectId(memberId) },
      { $set: { role: newRole } }
    );
    // Notification Discord — attendue avant la réponse : sur Vercel (serverless), l'exécution
    // peut être coupée dès la réponse envoyée, donc un appel non attendu après res.json() n'est
    // pas garanti d'aboutir (silencieusement manqué, de façon intermittente).
    if (member.role !== newRole) {
      try {
        const guilde = guildeId ? await req.db.collection('guildes').findOne({ _id: new ObjectId(guildeId) }) : null;
        await notifyDiscord('membre_role_change', {
          membre_name: member.name,
          guild_name: guilde?.name || '',
          old_role: member.role || 'membre',
          new_role: newRole
        }, guilde?.discord_channel_id || process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
      } catch (notifErr) {
        logger.error('[membres/role] Erreur notification Discord (non bloquant):', notifErr.message);
      }
    }

    res.json({ success: true, message: `Rôle du membre ${member.name} mis à jour avec succès` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Déplacer un membre vers une autre guilde (rôle automatiquement "membre")
router.put('/:id/guilde', async (req, res) => {
  try {
    const memberId = req.params.id;
    const newGuildeId = req.body.guilde_id;

    if (!newGuildeId) return res.status(400).json({ success: false, message: 'guilde_id requis' });

    // Je veux récupérer le name de la nouvelle guilde pour le message de succès
    const newGuilde = await req.db.collection('guildes').findOne({ _id: new ObjectId(newGuildeId) });
    if (!newGuilde) {
      return res.status(404).json({ success: false, message: 'Nouvelle guilde non trouvée' });
    }

    const member = await req.db.collection('membres').findOne({ _id: new ObjectId(memberId) });
    if (!member) return res.status(404).json({ success: false, message: 'Membre non trouvé' });

    // Forcer le rôle "membre" lors du déplacement (plus simple et logique)
    await req.db.collection('membres').updateOne(
      { _id: new ObjectId(memberId) },
      { $set: { guilde_id: newGuildeId, role: 'membre' } }
    );

    res.json({ success: true, message: `${member.name} déplacé vers la guilde ${newGuilde.name}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Supprimer un membre
router.delete('/:id', async (req, res) => {
  try {
    const member = await req.db.collection('membres').findOne({ _id: new ObjectId(req.params.id) });
    if (!member) return res.status(404).json({ success: false, message: 'Membre non trouvé' });

    await req.db.collection('membres').deleteOne({ _id: new ObjectId(req.params.id) });
    res.json({ success: true, message: `Membre ${member.name} supprimé avec succès` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;