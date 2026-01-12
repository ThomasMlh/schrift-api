import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, requireDb } from '../middleware/auth.js';

const router = express.Router();

// Middleware pour toutes les routes accessories_subeffect
router.use(requireDb);

// GET tous les accessories_subeffect (sans pagination, avec recherche optionnelle)
router.get('/', async (req, res) => {
  try {
    const { search } = req.query;

    // Construction de la requête
    const query = {};

    // Filtre par recherche sur le nom
    if (search && search.trim()) {
      query.name = { $regex: search.trim(), $options: 'i' };
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
    console.error('Erreur lors de la récupération des accessories_subeffect:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération des accessories_subeffect'
    });
  }
});

// GET un accessories_subeffect par ID
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
    console.error('Erreur lors de la récupération de l\'accessories subeffect:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération de l\'accessories subeffect'
    });
  }
});

// PUT mettre à jour un accessories_subeffect
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

    // Vérifier que l'accessories_subeffect existe
    const existingSubeffect = await req.db.collection('accessories_subeffect').findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!existingSubeffect) {
      return res.status(404).json({
        success: false,
        message: 'Accessories subeffect non trouvé'
      });
    }

    // Mettre à jour l'accessories_subeffect
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

    // Récupérer l'accessories_subeffect mis à jour
    const updatedSubeffect = await req.db.collection('accessories_subeffect').findOne({
      _id: new ObjectId(req.params.id)
    });

    res.json({
      success: true,
      message: 'Accessories subeffect mis à jour avec succès',
      data: updatedSubeffect
    });
  } catch (error) {
    console.error('Erreur lors de la mise à jour de l\'accessories subeffect:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la mise à jour de l\'accessories subeffect'
    });
  }
});

// DELETE supprimer un accessories_subeffect
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
    console.error('Erreur lors de la suppression de l\'accessories subeffect:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la suppression de l\'accessories subeffect'
    });
  }
});

export default router;
