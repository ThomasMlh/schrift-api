/**
 * Logique de calcul différentiel des scores.
 * 1 rotation sur 2 (index impair) = score différentiel (rawScore - previousRawScore).
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
 * Recalcule les scores différentiels suivants quand un score de base est modifié.
 * Recherche par {bbs_id, cycle_id, rotation_id} uniquement (pas user_id) : bbs_id identifie déjà
 * le compte de façon unique, et un compte transféré à un autre user garde ses anciens scores sous
 * l'ancien user_id — filtrer aussi sur user_id manquerait l'historique pré-transfert.
 * @returns {Promise<ObjectId[]>} IDs des scores recalculés
 */
export const recalculateAffectedDifferentials = async (db, cycle, rotationIndex, cycleId, bbsId) => {
  const recalculatedIds = [];

  for (let i = rotationIndex + 1; i < cycle.rotations.length; i++) {
    if (i % 2 !== 1) continue; // Seulement les rotations différentielles

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
    await db.collection('scores').updateOne(
      { _id: existing._id },
      { $set: { score: newScore, is_differential: true, updated_at: new Date() } }
    );

    recalculatedIds.push(existing._id);
  }

  return recalculatedIds;
}
