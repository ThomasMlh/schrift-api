import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, requireDb } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(requireDb);

// GET every banner (no pagination, optional name search)
router.get('/', async (req, res) => {
  try {
    const { search } = req.query;

    const query = {};

    if (search && search.trim()) {
      query.name = { $regex: search.trim(), $options: 'i' };
    }

    const banners = await req.db.collection('banners')
      .find(query)
      .sort({ name: 1 })
      .toArray();

    res.json({
      success: true,
      data: banners,
      count: banners.length
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des banners:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération des banners'
    });
  }
});

// GET a banner by id
router.get('/:id', async (req, res) => {
  try {
    const banner = await req.db.collection('banners').findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!banner) {
      return res.status(404).json({
        success: false,
        message: 'Bannière non trouvée'
      });
    }

    res.json({
      success: true,
      data: banner
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération de la bannière:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération de la bannière'
    });
  }
});

// PUT update a banner
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Le champ name est obligatoire'
      });
    }

    const existingBanner = await req.db.collection('banners').findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!existingBanner) {
      return res.status(404).json({
        success: false,
        message: 'Bannière non trouvée'
      });
    }

    const result = await req.db.collection('banners').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { name: name.trim() } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Bannière non trouvée'
      });
    }

    const updatedBanner = await req.db.collection('banners').findOne({
      _id: new ObjectId(req.params.id)
    });

    res.json({
      success: true,
      message: 'Bannière mise à jour avec succès',
      data: updatedBanner
    });
  } catch (error) {
    logger.error('Erreur lors de la mise à jour de la bannière:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la mise à jour de la bannière'
    });
  }
});

// DELETE a banner
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const result = await req.db.collection('banners').deleteOne({
      _id: new ObjectId(req.params.id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Bannière non trouvée'
      });
    }

    res.json({
      success: true,
      message: 'Bannière supprimée avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de la suppression de la bannière:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la suppression de la bannière'
    });
  }
});

export default router;
