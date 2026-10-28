import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, requireDb } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(requireDb);

// GET every skill (no pagination, optional name search)
router.get('/', async (req, res) => {
  try {
    const { search } = req.query;

    const query = {};

    if (search && search.trim()) {
      // French or English name
      const pattern = { $regex: search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      query.$or = [{ name: pattern }, { 'names.en': pattern }];
    }

    const skills = await req.db.collection('skills')
      .find(query)
      .sort({ priority: -1, name: 1 })
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

// GET a skill by id
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

// PUT update a skill
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Le champ name est obligatoire'
      });
    }

    const existingSkill = await req.db.collection('skills').findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!existingSkill) {
      return res.status(404).json({
        success: false,
        message: 'Skill non trouvé'
      });
    }

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

// DELETE a skill
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
