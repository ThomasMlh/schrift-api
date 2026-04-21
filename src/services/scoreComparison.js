import { ObjectId } from 'mongodb';

/**
 * Compare les scores de deux entités (joueurs ou guildes).
 */
export const compareEntities = async (db, fieldName, entity1, entity2, baseFilter, options) => {
  const results = {};

  for (const entityId of [entity1, entity2]) {
    const directScoreCount = await db.collection('scores').countDocuments({ [fieldName]: entityId });

    if (directScoreCount === 0) {
      results[entityId] = {
        entityInfo: null,
        stats: { averageScore: 0, averageRawScore: 0, totalScores: 0, maxScore: 0, minScore: 0, maxRawScore: 0, minRawScore: 0 }
      };
      continue;
    }

    const filter = { ...baseFilter, [fieldName]: entityId };
    const pipeline = [
      { $match: filter },
      {
        $group: {
          _id: null,
          averageScore: { $avg: '$score' },
          averageRawScore: { $avg: '$raw_score' },
          totalScores: { $sum: 1 },
          maxScore: { $max: '$score' },
          minScore: { $min: '$score' },
          maxRawScore: { $max: '$raw_score' },
          minRawScore: { $min: '$raw_score' }
        }
      },
      {
        $project: {
          _id: 0,
          averageScore: { $round: ['$averageScore', 2] },
          averageRawScore: { $round: ['$averageRawScore', 2] },
          totalScores: 1,
          maxScore: 1,
          minScore: 1,
          maxRawScore: 1,
          minRawScore: 1
        }
      }
    ];

    const stats = await db.collection('scores').aggregate(pipeline).toArray();

    let entityInfo = null;
    try {
      entityInfo = options.type === 'players'
        ? await db.collection('users').findOne({ _id: new ObjectId(entityId) })
        : await db.collection('guildes').findOne({ name: entityId });
    } catch { /* entityInfo reste null */ }

    results[entityId] = {
      entityInfo,
      stats: stats[0] ?? { averageScore: 0, averageRawScore: 0, totalScores: 0, maxScore: 0, minScore: 0, maxRawScore: 0, minRawScore: 0 }
    };
  }

  const e1 = results[entity1].stats;
  const e2 = results[entity2].stats;

  const diff = (a, b) => ({
    difference: a - b,
    percentage: b !== 0 ? ((a - b) / b * 100) : null
  });

  let winner = null;
  if (e1.averageScore > e2.averageScore) winner = entity1;
  else if (e2.averageScore > e1.averageScore) winner = entity2;

  return {
    entities: results,
    differences: {
      averageScore: diff(e1.averageScore, e2.averageScore),
      averageRawScore: diff(e1.averageRawScore, e2.averageRawScore),
      totalScores: diff(e1.totalScores, e2.totalScores)
    },
    winner,
    summary: {
      entity1: { id: entity1, averageScore: e1.averageScore, totalScores: e1.totalScores },
      entity2: { id: entity2, averageScore: e2.averageScore, totalScores: e2.totalScores }
    }
  };
}

export const getScopeDescription = (cycle_id, rotation_id) => {
  if (rotation_id && cycle_id) return 'Rotation spécifique d\'un cycle';
  if (cycle_id) return 'Cycle complet';
  if (rotation_id) return 'Rotation spécifique (tous cycles)';
  return 'Tous les scores';
}
