import { loadComparableScores, toObjectIds, cycleTimestamp } from './killerRecords.js';
import { getCyclesChronological } from './playerTrends.js';

/**
 * Scores à vérifier (probables erreurs de saisie) sur les cycles récents, pour les chefs et admins :
 *  - above_killer_record : nettement au-dessus du meilleur score jamais fait sur ce killer
 *  - far_above_usual / far_below_usual : très loin de l'habitude du joueur sur ce killer
 *    (chiffre en trop / en moins)
 *  - missing_base : rotation différentielle saisie sans le score de base de la semaine (le score
 *    affiché vaut alors tout le cumul hebdo)
 *  - same_value : même score brut pour plusieurs joueurs de la guilde sur la même rotation
 *    (copier-coller)
 * Un score marqué "vérifié" n'apparaît plus, tant que sa valeur ne change pas.
 */

// Au-delà de 120 % du meilleur score de tous les joueurs sur ce killer
const RECORD_FACTOR = 1.2;
// Minimum de scores existants sur le killer pour que son record serve de référence
const MIN_KILLER_SAMPLES = 5;
// Au-delà du double, ou sous le quart, de la moyenne du joueur sur ce killer
const ABOVE_USUAL_FACTOR = 2;
const BELOW_USUAL_FACTOR = 0.25;
// Cycles commencés examinés (les plus récents)
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

  // Référence : tous les scores comparables (tous joueurs, tous cycles) sur les killers concernés
  const rotationIds = [...new Set(recent.map((s) => s.rotation_id))];
  const comparable = await loadComparableScores(db, { rotation_id: { $in: rotationIds } });
  const comparableIds = new Set(comparable.map((s) => s._id.toString()));
  const byRotation = new Map();
  for (const s of comparable) {
    if (!byRotation.has(s.rotation_id)) byRotation.set(s.rotation_id, []);
    byRotation.get(s.rotation_id).push(s);
  }

  // Même score brut pour plusieurs comptes sur une même rotation d'une même guilde
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

  // Du plus récent au plus ancien : cycle le plus récent d'abord, puis dernière rotation d'abord
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

/** Marque un score comme vérifié à sa valeur actuelle (il réapparaît si la valeur change). */
export const reviewScoreAnomaly = async (db, score, user) => {
  await db.collection('scores').updateOne(
    { _id: score._id },
    { $set: { anomaly_review: { score: score.score, by_user_id: user?._id?.toString() || user?.id || null, at: new Date() } } }
  );
};
