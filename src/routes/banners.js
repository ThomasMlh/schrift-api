import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, requireDb } from '../middleware/auth.js';
import { logger } from '../utils/logger.js';
import { escapeRegex } from '../utils/regexUtils.js';

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

const SUMMON_LIST_CATEGORIES = ['character_gacha', 'character_ticket', 'accessory_gacha', 'accessory_ticket'];
const SUMMON_LIST_FIELDS = { gacha_group_id: 1, name: 1, names: 1, start_date: 1, end_date: 1, list_category: 1, summon_type: 1 };
const SUMMON_PAGE_SIZE = 24;
const SUMMON_MAX_PAGE_SIZE = 60;

const positiveInteger = (value, fallback) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
};

const summonListFilter = ({ search, type, year, ongoing }) => {
  const filter = {};
  if (search?.trim()) {
    const pattern = { $regex: escapeRegex(search.trim()), $options: 'i' };
    filter.$or = [{ name: pattern }, { 'names.fr': pattern }, { 'names.en': pattern }];
  }
  if (type) filter.summon_type = String(type);
  const yearNumber = positiveInteger(year, null);
  if (yearNumber) filter.started_at = { $gte: new Date(Date.UTC(yearNumber, 0, 1)), $lt: new Date(Date.UTC(yearNumber + 1, 0, 1)) };
  if (ongoing === 'true') {
    const now = new Date();
    filter.started_at = { ...filter.started_at, $lte: now };
    // No end date: the summon never expires
    filter.ended_at = { $not: { $lt: now } };
  }
  return filter;
};

// GET the summon catalog of a category, newest first, with the tab counts and the years it covers
router.get('/game', async (req, res) => {
  try {
    const category = req.query.category ?? SUMMON_LIST_CATEGORIES[0];
    if (!SUMMON_LIST_CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, message: 'Catégorie d\'invocation invalide' });
    }
    const page = positiveInteger(req.query.page, 1);
    const limit = Math.min(positiveInteger(req.query.limit, SUMMON_PAGE_SIZE), SUMMON_MAX_PAGE_SIZE);
    const filter = { ...summonListFilter(req.query), list_category: category };
    const collection = req.db.collection('banners');

    const [data, total, counts, years] = await Promise.all([
      collection.find(filter, { projection: SUMMON_LIST_FIELDS })
        .sort({ started_at: -1, gacha_group_id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      collection.countDocuments(filter),
      collection.aggregate([
        { $match: { list_category: { $in: SUMMON_LIST_CATEGORIES } } },
        { $group: { _id: '$list_category', count: { $sum: 1 } } },
      ]).toArray(),
      collection.aggregate([
        { $match: { list_category: category, started_at: { $type: 'date' } } },
        { $group: { _id: { $year: '$started_at' } } },
        { $sort: { _id: -1 } },
      ]).toArray(),
    ]);

    res.json({
      success: true,
      data,
      total,
      page,
      limit,
      counts: Object.fromEntries(counts.map(({ _id, count }) => [_id, count])),
      years: years.map(({ _id }) => _id),
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des invocations:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur lors de la récupération des invocations' });
  }
});

const SUMMON_CHARACTER_FIELDS = { name: 1, version: 1, version_name: 1, game_version: 1, game_id: 1, affinity: 1, attack_type: 1 };

// GET a game summon by group id, with the site characters it features (summon page)
router.get('/game/:gachaGroupId', async (req, res) => {
  try {
    const gachaGroupId = Number(req.params.gachaGroupId);
    if (!Number.isInteger(gachaGroupId)) {
      return res.status(400).json({ success: false, message: 'Identifiant d\'invocation invalide' });
    }
    const banner = await req.db.collection('banners').findOne({ gacha_group_id: gachaGroupId });
    if (!banner) {
      return res.status(404).json({ success: false, message: 'Invocation non trouvée' });
    }

    // The featured ids of an accessory summon are accessories, which could match a character game id
    const featuredIds = banner.list_category?.startsWith('accessory') ? [] : (banner.details?.featured ?? []).map(f => f.game_id);
    const gameIds = [...new Set([...featuredIds, ...(banner.character_game_ids ?? [])])];
    const characters = gameIds.length > 0
      ? await req.db.collection('characters').find({ game_id: { $in: gameIds } }, { projection: SUMMON_CHARACTER_FIELDS }).toArray()
      : [];

    res.json({ success: true, data: { ...banner, characters } });
  } catch (error) {
    logger.error('Erreur lors de la récupération de l\'invocation:', error);
    res.status(500).json({ success: false, message: 'Erreur serveur lors de la récupération de l\'invocation' });
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
