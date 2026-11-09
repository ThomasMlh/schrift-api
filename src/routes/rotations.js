import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, requireDb } from '../middleware/auth.js';
import { sendServerError, sendStatusCodeError } from '../utils/httpErrors.js';
import { getRotationHistory } from '../services/killerRecords.js';
import { getRotationRecords, previousPassageScores, rankRotationScores } from '../services/rotationRanking.js';
import { buildPaginationMeta, parsePaginationParams } from '../utils/pagination.js';

const router = express.Router();

router.use(requireDb);

// GET every rotation
router.get('/', async (req, res) => {
  try {
    const rotations = await req.db.collection('rotations').find().toArray();
    res.json(rotations);
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET a rotation by id
router.get('/:id', async (req, res) => {
  try {
    const rotation = await req.db.collection('rotations').findOne({ _id: new ObjectId(req.params.id) });
    if (!rotation) {
      return res.status(404).json({ success: false, message: 'Rotation non trouvée' });
    }
    res.json(rotation);
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET a killer's history (= a template rotation) across all cycles: records, per-cycle averages,
// score to beat. Public, like the rotation scores shown on the same page.
// Query: guild_id (optional) for the guild scope, cycle_id (optional) for the score to beat.
router.get('/:id/history', async (req, res) => {
  try {
    const { guild_id, cycle_id } = req.query;
    const history = await getRotationHistory(req.db, req.params.id, {
      guildId: guild_id || undefined,
      currentCycleId: cycle_id || undefined,
    });
    res.json({ success: true, data: history });
  } catch (err) {
    sendStatusCodeError(res, err, "Erreur serveur lors de la récupération de l'historique du killer", "Erreur lors de la récupération de l'historique du killer:");
  }
});

// GET the ranking of a rotation in one cycle, with each player's score on the previous passage.
// Query: cycle_id (required), guild_id (optional), page, limit.
router.get('/:id/scores', async (req, res) => {
  try {
    const { cycle_id: cycleId, guild_id: guildId } = req.query;
    if (!ObjectId.isValid(req.params.id) || !cycleId || !ObjectId.isValid(cycleId)) {
      return res.status(400).json({ success: false, message: 'Rotation ou cycle invalide' });
    }
    const cycle = await req.db.collection('cycles').findOne({ _id: new ObjectId(cycleId) }, { projection: { rotations: 1 } });
    if (!cycle?.rotations?.some((r) => r.rotation_id === req.params.id)) {
      return res.status(404).json({ success: false, message: 'Rotation absente de ce cycle' });
    }
    const { page, limit, skip } = parsePaginationParams(req.query);
    const ranked = await rankRotationScores(req.db, { cycleId, rotationId: req.params.id, guildId: guildId || undefined });
    const pageScores = ranked.slice(skip, skip + limit);
    const previous = await previousPassageScores(req.db, {
      cycleId, rotationId: req.params.id, bbsIds: pageScores.map((s) => s.bbs_id),
    });
    res.json({
      success: true,
      data: pageScores.map((score) => ({ ...score, previous: previous.get(score.bbs_id) ?? null })),
      pagination: buildPaginationMeta(page, limit, ranked.length, pageScores.length),
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET the best score of each player on a rotation over every cycle. Query: guild_id, page, limit.
router.get('/:id/records', async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Rotation invalide' });
    }
    const { page, limit, skip } = parsePaginationParams(req.query);
    const records = await getRotationRecords(req.db, req.params.id, { guildId: req.query.guild_id || undefined });
    const pageRecords = records.slice(skip, skip + limit);
    res.json({ success: true, data: pageRecords, pagination: buildPaginationMeta(page, limit, records.length, pageRecords.length) });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST create a rotation
router.post('/', requireAdmin, async (req, res) => {
  try {
    const result = await req.db.collection('rotations').insertOne(req.body);
    res.json({ 
      success: true,
      insertedId: result.insertedId,
      message: 'Rotation ajoutée avec succès'
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

// POST create several rotations
router.post('/bulk', requireAdmin, async (req, res) => {
  try {
    const rotations = req.body;
    if (!Array.isArray(rotations) || rotations.length === 0) {
      return res.status(400).json({ success: false, message: 'Aucune rotation à ajouter' });
    }

    const result = await req.db.collection('rotations').insertMany(rotations);
    res.json({ 
      success: true,
      insertedCount: result.insertedCount,
      insertedIds: result.insertedIds,
      message: `${result.insertedCount} rotations ajoutées avec succès`
    });
  } catch (err) {
    sendServerError(res, err);
  }
});

// PUT update a rotation
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const rotationId = req.params.id;
    
    const result = await req.db.collection('rotations').updateOne(
      { _id: new ObjectId(rotationId) },
      { $set: req.body }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: 'Rotation non trouvée' });
    }

    res.json({ success: true, message: 'Rotation mise à jour avec succès' });
  } catch (err) {
    sendServerError(res, err);
  }
});

// DELETE a rotation
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const result = await req.db.collection('rotations').deleteOne({ _id: new ObjectId(req.params.id) });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: 'Rotation non trouvée' });
    }

    res.json({ success: true, message: 'Rotation supprimée avec succès' });
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;