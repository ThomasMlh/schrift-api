import express from 'express';
import { ObjectId } from 'mongodb';
import { requireAdmin, validateObjectIdParam } from '../../middleware/auth.js';
import { parsePaginationParams, buildPaginationMeta } from '../../utils/pagination.js';
import { USER_BUILD } from '../../utils/projections.js';
import { notifyDiscord } from '../../utils/notifyDiscord.js';
import { getUserDisplayName } from '../../utils/nameMatching.js';
import { logger } from '../../utils/logger.js';
import { enrichWithUser, enrichWithRotation, enrichTeamWithCharacters } from './enrich.js';

const router = express.Router();

// GET /builds - Récupérer tous les builds avec filtres et pagination
router.get('/', async (req, res) => {
  try {
    const { rotation_id, isValid, character_id } = req.query;
    const { page, limit, skip } = parsePaginationParams(req.query, 20, 100);

    // Construction du filtre
    const filter = {};

    if (rotation_id) {
      filter.rotation_id = rotation_id;
    }

    if (isValid !== undefined) {
      filter.isValid = isValid === 'true' || isValid === true;
    }

    if (character_id && ObjectId.isValid(character_id)) {
      filter['team.id_character'] = character_id;
    }

    const builds = await req.db.collection('builds')
      .find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    // Batch-load users et rotations pour éviter N requêtes par item
    const userIds = [...new Set(builds.map(b => b.user_id).filter(id => id && ObjectId.isValid(id)))];
    const userMap = new Map();
    if (userIds.length > 0) {
      const users = await req.db.collection('users').find(
        { _id: { $in: userIds.map(id => new ObjectId(id)) } },
        { projection: USER_BUILD }
      ).toArray();
      users.forEach(u => userMap.set(u._id.toString(), u));
    }

    const rotationIds = [...new Set(builds.map(b => b.rotation_id).filter(id => id && ObjectId.isValid(id)))];
    const rotationMap = new Map();
    if (rotationIds.length > 0) {
      const rotations = await req.db.collection('rotations').find(
        { _id: { $in: rotationIds.map(id => new ObjectId(id)) } },
        { projection: { killer: 1, attack: 1, alteration: 1, start_date: 1, end_date: 1, cycle_id: 1 } }
      ).toArray();
      rotations.forEach(r => rotationMap.set(r._id.toString(), r));
    }

    const enrichedBuilds = [];
    for (const build of builds) {
      const enrichedTeam = await enrichTeamWithCharacters(build.team, req.db);
      enrichedBuilds.push({
        ...build,
        team: enrichedTeam,
        user: userMap.get(build.user_id) || null,
        rotation: rotationMap.get(build.rotation_id) || null
      });
    }

    const totalCount = await req.db.collection('builds').countDocuments(filter);

    res.json({
      success: true,
      data: enrichedBuilds,
      pagination: buildPaginationMeta(page, limit, totalCount, enrichedBuilds.length),
      filters: {
        rotation_id: rotation_id || null,
        isValid: isValid || null,
        character_id: character_id || null
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération des builds:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération des builds'
    });
  }
});

// GET /builds/:id - Récupérer un build spécifique
router.get('/:id', validateObjectIdParam('id'), async (req, res) => {
  try {
    const { id } = req.params;
    const build = await req.db.collection('builds').findOne({
      _id: new ObjectId(id)
    });

    if (!build) {
      return res.status(404).json({
        success: false,
        message: 'Build non trouvé'
      });
    }

    // Enrichir la team avec les données des personnages et utilisateur
    const enrichedTeam = await enrichTeamWithCharacters(build.team, req.db);
    const enrichedBuild = await enrichWithUser(build, req.db);
    const enrichedWithRotation = await enrichWithRotation(enrichedBuild, req.db);

    res.json({
      success: true,
      data: {
        ...enrichedWithRotation,
        team: enrichedTeam
      }
    });
  } catch (error) {
    logger.error('Erreur lors de la récupération du build:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la récupération du build'
    });
  }
});

// DELETE /builds/:id - Supprimer un build
router.delete('/:id', requireAdmin, validateObjectIdParam('id'), async (req, res) => {
  try {
    const { id } = req.params;

    const buildToDelete = await req.db.collection('builds').findOne({ _id: new ObjectId(id) });

    const result = await req.db.collection('builds').deleteOne({
      _id: new ObjectId(id)
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        success: false,
        message: 'Build non trouvé'
      });
    }

    // Notification Discord — attendue avant la réponse.
    try {
      const enrichedBuild = await enrichWithUser(buildToDelete, req.db);
      const enrichedWithRotation = await enrichWithRotation(enrichedBuild, req.db);
      const rotation = enrichedWithRotation.rotation;
      await notifyDiscord('build_delete', {
        action: 'delete',
        proposed_by: enrichedBuild.user ? getUserDisplayName(enrichedBuild.user) : 'Anonyme',
        description: buildToDelete.description,
        killer: rotation?.killer || '',
        attack: rotation?.attack || ''
      });
    } catch (notifErr) {
      logger.error('[builds/delete] Erreur notification Discord (non bloquant):', notifErr.message);
    }

    res.json({
      success: true,
      message: 'Build supprimé avec succès'
    });
  } catch (error) {
    logger.error('Erreur lors de la suppression du build:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur serveur lors de la suppression du build'
    });
  }
});

export default router;
