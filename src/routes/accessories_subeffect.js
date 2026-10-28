import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, requireDb } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(requireDb);

// GET every accessory sub-effect (no pagination, optional name search)
router.get('/', async (req, res) => {
  try {
    const { search } = req.query;

    const query = {};

    if (search && search.trim()) {
      // French or English name
      const pattern = { $regex: search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      query.$or = [{ name: pattern }, { 'names.en': pattern }];
    }

    const subeffects = await req.db.collection('accessories_subeffect')
      .find(query)
      .sort({ name: 1 })
      .toArray();

    res.json({
      success: true,
      data: subeffects,
      count: subeffects.length
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des accessories_subeffect:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération des accessories_subeffect'
    });
  }
});

// GET a sub-effect by id
router.get('/:id', async (req, res) => {
  try {
    const subeffect = await req.db.collection('accessories_subeffect').findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!subeffect) {
      return res.status(404).json({
        success: false,
        message: 'Accessories subeffect non trouvé'
      });
    }

    res.json({
      success: true,
      data: subeffect
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération de l\'accessories subeffect:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération de l\'accessories subeffect'
    });
  }
});

// PUT update a sub-effect
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Le champ name est obligatoire'
      });
    }

    const existingSubeffect = await req.db.collection('accessories_subeffect').findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!existingSubeffect) {
      return res.status(404).json({
        success: false,
        message: 'Accessories subeffect non trouvé'
      });
    }

    const result = await req.db.collection('accessories_subeffect').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { name: name.trim() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Accessories subeffect non trouvé'
      });
    }

    const updatedSubeffect = await req.db.collection('accessories_subeffect').findOne({
      _id: new ObjectId(req.params.id)
    });

    res.json({
      success: true,
      message: 'Accessories subeffect mis à jour avec succès',
      data: updatedSubeffect
    });
  } catch (error) {
    logger.error('Erreur lors de la mise à jour de l\'accessories subeffect:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la mise à jour de l\'accessories subeffect'
    });
  }
});

// DELETE a sub-effect
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const result = await req.db.collection('accessories_subeffect').deleteOne({
      _id: new ObjectId(req.params.id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Accessories subeffect non trouvé'
      });
    }

    res.json({
      success: true,
      message: 'Accessories subeffect supprimé avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de la suppression de l\'accessories subeffect:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la suppression de l\'accessories subeffect'
    });
  }
});

export default router;
