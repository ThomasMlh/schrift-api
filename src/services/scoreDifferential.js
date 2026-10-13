import { recordScoreChange } from './scoreHistory.js';

/**
 * Differential score computation.
 * Every other rotation (odd index) holds a differential score (rawScore - previousRawScore).
 */

export const buildRotationIndexMap = (cycle) => {
  const map = new Map();
  cycle.rotations.forEach((rotation, index) => {
    map.set(rotation.rotation_id, index);
  });
  return map;
}

export const computeDifferential = (rawScore, rotationIndex, previousRawScore) => {
  if (rotationIndex > 0 && rotationIndex % 2 === 1) {
    return {
      score: previousRawScore !== undefined ? Math.max(0, rawScore - previousRawScore) : rawScore,
      isDifferential: true
    };
  }
  return { score: rawScore, isDifferential: false };
}

/**
 * Recomputes the following differential scores when a base score changes.
 * Looks up {bbs_id, cycle_id, rotation_id} only (not user_id): bbs_id already identifies the account,
 * and an account transferred to another user keeps its old scores under the previous user_id, so
 * filtering on user_id too would miss the pre-transfer history.
 * @returns {Promise<ObjectId[]>} ids of the recomputed scores
 */
export const recalculateAffectedDifferentials = async (db, cycle, rotationIndex, cycleId, bbsId) => {
  const recalculatedIds = [];

  for (let i = rotationIndex + 1; i < cycle.rotations.length; i++) {
    if (i % 2 !== 1) continue; // Differential rotations only

    const nextRotationId = cycle.rotations[i].rotation_id;
    const existing = await db.collection('scores').findOne({
      bbs_id: bbsId,
      cycle_id: cycleId,
      rotation_id: nextRotationId
    });

    if (!existing) continue;

    const previousRotationId = cycle.rotations[i - 1].rotation_id;
    const previousScore = await db.collection('scores').findOne({
      bbs_id: bbsId,
      cycle_id: cycleId,
      rotation_id: previousRotationId
    });

    if (!previousScore) continue;

    const newScore = Math.max(0, existing.raw_score - previousScore.raw_score);
    const recalculated = { score: newScore, is_differential: true, updated_at: new Date() };
    await db.collection('scores').updateOne({ _id: existing._id }, { $set: recalculated });
    // Automatic recomputation (no author); ignored by the history when the score did not change
    await recordScoreChange(db, { action: 'recalculate', source: 'auto', before: existing, after: recalculated });

    recalculatedIds.push(existing._id);
  }

  return recalculatedIds;
}
