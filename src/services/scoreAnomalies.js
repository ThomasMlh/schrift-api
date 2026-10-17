import { loadComparableScores, toObjectIds, cycleTimestamp } from './killerRecords.js';
import { getCyclesChronological } from './playerTrends.js';

/**
 * Scores to review (probable typos) on recent cycles, for leaders and admins:
 *  - above_killer_record: well above the best score ever made on this killer
 *  - far_above_usual / far_below_usual: very far from the player's usual level on this killer
 *    (an extra or missing digit)
 *  - missing_base: differential rotation entered without the week's base score (the displayed
 *    score is then the whole weekly total)
 *  - same_value: same raw score for several players of the guild on the same rotation (copy-paste)
 * A score marked as reviewed no longer shows up until its value changes.
 */

// Above 120% of every player's best score on this killer
const RECORD_FACTOR = 1.2;
// Minimum number of existing scores on the killer for its record to be used as a reference
const MIN_KILLER_SAMPLES = 5;
// Above twice, or below a quarter of, the player's average on this killer
export const ABOVE_USUAL_FACTOR = 2;
export const BELOW_USUAL_FACTOR = 0.25;
// Number of latest started cycles examined
const RECENT_CYCLES = 2;

export const ANOMALY_TYPES = ['above_killer_record', 'far_above_usual', 'far_below_usual', 'missing_base', 'same_value'];

const isReviewed = (s) => s.anomaly_review && s.anomaly_review.score === s.score;

export const getScoreAnomalies = async (db, { guildIds, now = Date.now() }) => {
  const cycles = (await getCyclesChronological(db)).filter((c) => cycleTimestamp(c) <= now).slice(-RECENT_CYCLES);
  if (cycles.length === 0 || guildIds.length === 0) return [];
  const cycleById = new Map(cycles.map((c) => [c._id.toString(), c]));

  const recent = await db.collection('scores').find({
    cycle_id: { $in: [...cycleById.keys()] },
    guild_id: { $in: guildIds },
    bbs_id: { $ne: null },
  }).toArray();
  if (recent.length === 0) return [];

  // Reference: every comparable score (all players, all cycles) on the involved killers
  const rotationIds = [...new Set(recent.map((s) => s.rotation_id))];
  const comparable = await loadComparableScores(db, { rotation_id: { $in: rotationIds } });
  const comparableIds = new Set(comparable.map((s) => s._id.toString()));
  const byRotation = new Map();
  for (const s of comparable) {
    if (!byRotation.has(s.rotation_id)) byRotation.set(s.rotation_id, []);
    byRotation.get(s.rotation_id).push(s);
  }

  // Same raw score for several accounts on the same rotation of the same guild
  const sameValueGroups = new Map();
  for (const s of recent) {
    if (!(s.raw_score > 0)) continue;
    const key = `${s.cycle_id}|${s.rotation_id}|${s.guild_id}|${s.raw_score}`;
    if (!sameValueGroups.has(key)) sameValueGroups.set(key, []);
    sameValueGroups.get(key).push(s);
  }

  const anomalies = [];
  for (const s of recent) {
    if (isReviewed(s)) continue;
    const id = s._id.toString();
    const issues = [];

    if (s.is_differential && !comparableIds.has(id)) {
      issues.push({ type: 'missing_base' });
    } else if ((s.score || 0) > 0) {
      const others = (byRotation.get(s.rotation_id) || []).filter((o) => o._id.toString() !== id);
      if (others.length >= MIN_KILLER_SAMPLES) {
        const best = Math.max(...others.map((o) => o.score || 0));
        if (best > 0 && s.score > best * RECORD_FACTOR) issues.push({ type: 'above_killer_record', reference: best });
      }

      const own = others.filter((o) => o.bbs_id === s.bbs_id);
      if (own.length > 0) {
        const usual = Math.round(own.reduce((sum, o) => sum + (o.score || 0), 0) / own.length);
        if (usual > 0 && s.score > usual * ABOVE_USUAL_FACTOR) issues.push({ type: 'far_above_usual', reference: usual });
        if (usual > 0 && s.score < usual * BELOW_USUAL_FACTOR) issues.push({ type: 'far_below_usual', reference: usual });
      }
    }

    const twins = sameValueGroups.get(`${s.cycle_id}|${s.rotation_id}|${s.guild_id}|${s.raw_score}`) || [];
    if (twins.length > 1) {
      issues.push({ type: 'same_value', with: twins.filter((t) => t._id.toString() !== id).map((t) => t.bbs_name || t.bbs_id) });
    }

    if (issues.length > 0) anomalies.push({ score: s, issues });
  }
  if (anomalies.length === 0) return [];

  const [rotations, guilds] = await Promise.all([
    db.collection('rotations').find({ _id: { $in: toObjectIds(rotationIds) } }, { projection: { killer: 1, attack: 1, alteration: 1 } }).toArray(),
    db.collection('guildes').find({ _id: { $in: toObjectIds(guildIds) } }, { projection: { name: 1 } }).toArray(),
  ]);
  const rotationById = new Map(rotations.map((r) => [r._id.toString(), r]));
  const guildNameById = new Map(guilds.map((g) => [g._id.toString(), g.name]));

  // Most recent first: latest cycle first, then latest rotation first
  const recency = (s) => {
    const cycleIndex = cycles.findIndex((c) => c._id.toString() === s.cycle_id);
    const rotationIndex = cycleById.get(s.cycle_id)?.rotations?.findIndex((r) => r.rotation_id === s.rotation_id) ?? 0;
    return cycleIndex * 1000 + rotationIndex;
  };

  return anomalies
    .sort((a, b) => recency(b.score) - recency(a.score))
    .map(({ score: s, issues }) => {
      const cycle = cycleById.get(s.cycle_id);
      const rotation = rotationById.get(s.rotation_id);
      return {
        score_id: s._id.toString(),
        bbs_id: s.bbs_id,
        bbs_name: s.bbs_name || null,
        user_id: s.user_id || null,
        guild_id: s.guild_id,
        guild_name: guildNameById.get(s.guild_id) || null,
        cycle_id: s.cycle_id,
        cycle_name: cycle?.name || null,
        cycle_year: cycle?.year || null,
        rotation_id: s.rotation_id,
        rotation_position: cycle?.rotations?.find((r) => r.rotation_id === s.rotation_id)?.position ?? null,
        killer: rotation?.killer || null,
        attack: rotation?.attack || null,
        alteration: rotation?.alteration || null,
        score: s.score,
        raw_score: s.raw_score,
        is_differential: !!s.is_differential,
        issues,
      };
    });
};

/** Marks a score as reviewed at its current value (it comes back if the value changes). */
export const reviewScoreAnomaly = async (db, score, user) => {
  await db.collection('scores').updateOne(
    { _id: score._id },
    { $set: { anomaly_review: { score: score.score, by_user_id: user?._id?.toString() || user?.id || null, at: new Date() } } }
  );
};
