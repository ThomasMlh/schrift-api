import { ObjectId } from 'mongodb';
import { loadComparableScores } from './killerRecords.js';
import { ABOVE_USUAL_FACTOR, BELOW_USUAL_FACTOR } from './scoreAnomalies.js';

/**
 * Repères affichés à côté de chaque champ de la saisie groupée, pour repérer une faute de frappe
 * avant d'enregistrer :
 *  - usual_score : moyenne du compte sur ce killer (mêmes scores comparables que l'outil d'anomalies)
 *  - base_raw : rotation différentielle uniquement, score brut de la rotation précédente du cycle
 *    (le cumul saisi ne peut pas lui être inférieur)
 * Les seuils d'alerte sont ceux de scoreAnomalies, renvoyés pour que le front applique les mêmes.
 */
export const getBulkEntryContext = async (db, { cycleId, rotationId, bbsIds }) => {
  const cycle = ObjectId.isValid(cycleId)
    ? await db.collection('cycles').findOne({ _id: new ObjectId(cycleId) }, { projection: { rotations: 1 } })
    : null;
  if (!cycle) throw Object.assign(new Error('Cycle introuvable'), { statusCode: 404 });

  const rotationIndex = (cycle.rotations || []).findIndex((r) => r.rotation_id === rotationId);
  if (rotationIndex === -1) throw Object.assign(new Error('Rotation introuvable dans ce cycle'), { statusCode: 404 });
  // Même règle que computeDifferential : les rotations d'index impair sont différentielles
  const isDifferential = rotationIndex > 0 && rotationIndex % 2 === 1;

  const accounts = Object.fromEntries(bbsIds.map((id) => [id, { usual_score: null, base_raw: null }]));
  if (bbsIds.length === 0) {
    return { is_differential: isDifferential, thresholds: { above: ABOVE_USUAL_FACTOR, below: BELOW_USUAL_FACTOR }, accounts };
  }

  const [history, bases] = await Promise.all([
    loadComparableScores(db, { rotation_id: rotationId, bbs_id: { $in: bbsIds }, cycle_id: { $ne: cycleId } }),
    isDifferential
      ? db.collection('scores').find(
        { cycle_id: cycleId, rotation_id: cycle.rotations[rotationIndex - 1].rotation_id, bbs_id: { $in: bbsIds } },
        { projection: { bbs_id: 1, raw_score: 1 } }
      ).toArray()
      : [],
  ]);

  const byAccount = new Map();
  for (const s of history) {
    if (!(s.score > 0)) continue;
    if (!byAccount.has(s.bbs_id)) byAccount.set(s.bbs_id, []);
    byAccount.get(s.bbs_id).push(s);
  }
  for (const [bbsId, scores] of byAccount) {
    accounts[bbsId].usual_score = Math.round(scores.reduce((sum, s) => sum + s.score, 0) / scores.length);
  }
  for (const base of bases) {
    if (accounts[base.bbs_id]) accounts[base.bbs_id].base_raw = base.raw_score ?? null;
  }

  return { is_differential: isDifferential, thresholds: { above: ABOVE_USUAL_FACTOR, below: BELOW_USUAL_FACTOR }, accounts };
};
