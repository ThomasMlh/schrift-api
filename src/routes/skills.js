import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, requireDb } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// Middleware pour toutes les routes skills
router.use(requireDb);

// GET tous les skills (sans pagination, avec recherche optionnelle)
router.get('/', async (req, res) => {
  try {
    const { search } = req.query;

    // Construction de la requête
    const query = {};

    // Filtre par recherche sur le nom
    if (search && search.trim()) {
      query.name = { $regex: search.trim(), $options: 'i' };
    }

    const skills = await req.db.collection('skills')
      .find(query)
      .sort({ name: 1 })
      .toArray();

    res.json({
      success: true,
      data: skills,
      count: skills.length
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des skills:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération des skills'
    });
  }
});

// GET un skill par ID
router.get('/:id', async (req, res) => {
  try {
    const skill = await req.db.collection('skills').findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!skill) {
      return res.status(404).json({
        success: false,
        message: 'Skill non trouvé'
      });
    }

    res.json({
      success: true,
      data: skill
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération du skill:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération du skill'
    });
  }
});

// PUT mettre à jour un skill
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;

    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Le champ name est obligatoire'
      });
    }

    // Vérifier que le skill existe
    const existingSkill = await req.db.collection('skills').findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!existingSkill) {
      return res.status(404).json({
        success: false,
        message: 'Skill non trouvé'
      });
    }

    // Mettre à jour le skill
    const result = await req.db.collection('skills').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { name: name.trim() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Skill non trouvé'
      });
    }

    // Récupérer le skill mis à jour
    const updatedSkill = await req.db.collection('skills').findOne({
      _id: new ObjectId(req.params.id)
    });

    res.json({
      success: true,
      message: 'Skill mis à jour avec succès',
      data: updatedSkill
    });
  } catch (error) {
    logger.error('Erreur lors de la mise à jour du skill:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la mise à jour du skill'
    });
  }
});

// DELETE supprimer un skill
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const result = await req.db.collection('skills').deleteOne({
      _id: new ObjectId(req.params.id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Skill non trouvé'
      });
    }

    res.json({
      success: true,
      message: 'Skill supprimé avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de la suppression du skill:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la suppression du skill'
    });
  }
});

export default router;
