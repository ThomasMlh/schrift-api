import { ObjectId } from 'mongodb';
import { loadComparableScores } from './killerRecords.js';
import { ABOVE_USUAL_FACTOR, BELOW_USUAL_FACTOR } from './scoreAnomalies.js';

/**
 * References shown next to each bulk entry field, to catch typos before saving:
 *  - usual_score: the account's average on this killer (same comparable scores as the anomaly tool)
 *  - base_raw: differential rotations only, raw score of the previous rotation of the cycle
 *    (the entered running total cannot be lower)
 * Alert thresholds come from scoreAnomalies and are returned so the front end applies the same ones.
 */
export const getBulkEntryContext = async (db, { cycleId, rotationId, bbsIds }) => {
  const cycle = ObjectId.isValid(cycleId)
    ? await db.collection('cycles').findOne({ _id: new ObjectId(cycleId) }, { projection: { rotations: 1 } })
    : null;
  if (!cycle) throw Object.assign(new Error('Cycle introuvable'), { statusCode: 404 });

  const rotationIndex = (cycle.rotations || []).findIndex((r) => r.rotation_id === rotationId);
  if (rotationIndex === -1) throw Object.assign(new Error('Rotation introuvable dans ce cycle'), { statusCode: 404 });
  // Same rule as computeDifferential: odd-index rotations are differential
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
