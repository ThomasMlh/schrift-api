import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, requireDb } from '../middleware/auth.js';
import { FTPUploader } from '../utils/ftp.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.use(requireDb);

// GET accessory codes available on the bucket (FTP listing of /accessories/ subfolders)
router.get('/codes', requireAdmin, async (req, res) => {
  const ftp = new FTPUploader();
  try {
    await ftp.connect();
    const codes = await ftp.listSubdirectories('/bucket.bbs-schrift.fr/accessories');
    res.json({ success: true, codes });
  } catch (error) {
    logger.error('Erreur liste FTP accessories:', error);
    res.status(500).json({ success: false, message: 'Impossible de lister les codes', error: error.message });
  } finally {
    ftp.disconnect();
  }
});

// POST create an accessory
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, code } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Le champ name est obligatoire' });
    }
    const doc = { name: name.trim(), ...(code && code.trim() ? { code: code.trim() } : {}) };
    const result = await req.db.collection('accessories').insertOne(doc);
    const created = await req.db.collection('accessories').findOne({ _id: result.insertedId });
    res.status(201).json({ success: true, message: 'Accessoire créé avec succès', data: created });
  } catch (error) {
    logger.error('Erreur lors de la création de l\'accessory:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur lors de la création de l\'accessory' });
  }
});

// GET every accessory (no pagination, optional name search)
router.get('/', async (req, res) => {
  try {
    const { search } = req.query;

    const query = {};

    if (search && search.trim()) {
      // French or English name
      const pattern = { $regex: search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      query.$or = [{ name: pattern }, { 'names.en': pattern }];
    }

    const accessories = await req.db.collection('accessories')
      .find(query)
      .sort({ name: 1 })
      .toArray();

    res.json({
      success: true,
      data: accessories,
      count: accessories.length
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des accessories:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération des accessories'
    });
  }
});

// GET an accessory by id
router.get('/:id', async (req, res) => {
  try {
    const accessory = await req.db.collection('accessories').findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!accessory) {
      return res.status(404).json({
        success: false,
        message: 'Accessory non trouvé'
      });
    }

    res.json({
      success: true,
      data: accessory
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération de l\'accessory:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération de l\'accessory'
    });
  }
});

// PUT update an accessory
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    const { code } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Le champ name est obligatoire'
      });
    }

    const existingAccessory = await req.db.collection('accessories').findOne({
      _id: new ObjectId(req.params.id)
    });

    if (!existingAccessory) {
      return res.status(404).json({
        success: false,
        message: 'Accessory non trouvé'
      });
    }

    const result = await req.db.collection('accessories').updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { name: name.trim(), ...(code !== undefined ? { code: code.trim() || null } : {}) } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Accessory non trouvé'
      });
    }

    const updatedAccessory = await req.db.collection('accessories').findOne({
      _id: new ObjectId(req.params.id)
    });

    res.json({
      success: true,
      message: 'Accessory mis à jour avec succès',
      data: updatedAccessory
    });
  } catch (error) {
    logger.error('Erreur lors de la mise à jour de l\'accessory:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la mise à jour de l\'accessory'
    });
  }
});

// DELETE an accessory
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const result = await req.db.collection('accessories').deleteOne({
      _id: new ObjectId(req.params.id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Accessory non trouvé'
      });
    }

    res.json({
      success: true,
      message: 'Accessory supprimé avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de la suppression de l\'accessory:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la suppression de l\'accessory'
    });
  }
});

export default router;
