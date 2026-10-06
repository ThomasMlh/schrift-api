import { loadComparableScores, cycleTimestamp, toObjectIds } from './killerRecords.js';

/**
 * Tendances par compte bbs : progression d'un cycle à l'autre et baisses de régime récentes.
 * Comme pour les records, seuls les scores comparables (loadComparableScores) sont pris en compte.
 */

/** Tous les cycles, du plus ancien au plus récent (date de début de la première rotation). */
export const getCyclesChronological = async (db) => {
  const cycles = await db.collection('cycles')
    .find({}, { projection: { name: 1, year: 1, rotations: 1, created_at: 1 } })
    .toArray();
  return cycles.sort((a, b) => cycleTimestamp(a) - cycleTimestamp(b));
};

/** Cycle qui précède chronologiquement `cycleId`, ou null s'il n'y en a pas. */
export const getPreviousCycle = async (db, cycleId) => {
  const cycles = await getCyclesChronological(db);
  const index = cycles.findIndex((c) => c._id.toString() === cycleId.toString());
  return index > 0 ? cycles[index - 1] : null;
};

const groupByAccount = (scores) => {
  const byAccount = new Map();
  for (const s of scores) {
    if (!byAccount.has(s.bbs_id)) {
      byAccount.set(s.bbs_id, { bbs_id: s.bbs_id, bbs_name: s.bbs_name, user_id: s.user_id, guild_id: s.guild_id, sum: 0, count: 0 });
    }
    const account = byAccount.get(s.bbs_id);
    account.sum += s.score || 0;
    account.count += 1;
  }
  return byAccount;
};

/**
 * Progression de la moyenne de chaque compte entre le cycle précédent et `cycle`, triée de la
 * plus forte hausse (en %) à la plus forte baisse. Un compte doit avoir au moins `minScores`
 * scores (et au moins un) sur chacun des deux cycles. `bbsIds` restreint aux comptes donnés
 * (membres actuels d'une guilde).
 */
export const getProgression = async (db, { cycle, bbsIds = null, minScores = 0 }) => {
  const previousCycle = await getPreviousCycle(db, cycle._id);
  if (!previousCycle) return { previousCycle: null, rows: [] };

  const currentId = cycle._id.toString();
  const previousId = previousCycle._id.toString();
  const scores = await loadComparableScores(db, {
    cycle_id: { $in: [currentId, previousId] },
    ...(bbsIds && { bbs_id: { $in: bbsIds } }),
  });

  const current = groupByAccount(scores.filter((s) => s.cycle_id === currentId));
  const previous = groupByAccount(scores.filter((s) => s.cycle_id === previousId));
  const required = Math.max(1, minScores);

  const rows = [];
  for (const [bbsId, cur] of current) {
    const prev = previous.get(bbsId);
    if (!prev || cur.count < required || prev.count < required) continue;

    const currentAverage = Math.round(cur.sum / cur.count);
    const previousAverage = Math.round(prev.sum / prev.count);
    if (previousAverage <= 0) continue;

    rows.push({
      bbs_id: bbsId,
      bbs_name: cur.bbs_name || prev.bbs_name || null,
      user_id: cur.user_id || prev.user_id || null,
      guild_id: cur.guild_id || null,
      averageScore: currentAverage,
      previousAverageScore: previousAverage,
      progression: currentAverage - previousAverage,
      progressionPercent: Math.round(((currentAverage - previousAverage) / previousAverage) * 1000) / 10,
      totalScores: cur.count,
      previousTotalScores: prev.count,
    });
  }

  rows.sort((a, b) => b.progressionPercent - a.progressionPercent || b.progression - a.progression);
  return { previousCycle, rows };
};

/**
 * Complète des lignes portant user_id/guild_id avec l'identité Discord (avatar, global_name) et le
 * nom de la guilde, comme le fait lookupUserAndGuild pour les classements agrégés en base.
 */
export const attachIdentity = async (db, rows) => {
  const userIds = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
  const guildIds = [...new Set(rows.map((r) => r.guild_id).filter(Boolean))];

  const [users, guilds] = await Promise.all([
    userIds.length
      ? db.collection('users').find(
        { $or: [{ _id: { $in: toObjectIds(userIds) } }, { discord_id: { $in: userIds } }] },
        { projection: { discord_id: 1, avatar: 1, global_name: 1 } }
      ).toArray()
      : [],
    guildIds.length
      ? db.collection('guildes').find({ _id: { $in: toObjectIds(guildIds) } }, { projection: { name: 1 } }).toArray()
      : [],
  ]);

  const userByKey = new Map();
  for (const u of users) {
    userByKey.set(u._id.toString(), u);
    if (u.discord_id) userByKey.set(u.discord_id, u);
  }
  const guildNameById = new Map(guilds.map((g) => [g._id.toString(), g.name]));

  return rows.map((row) => {
    const user = userByKey.get(row.user_id);
    return {
      ...row,
      discord_id: user?.discord_id,
      global_name: user?.global_name,
      avatar: user?.avatar,
      guild_name: guildNameById.get(row.guild_id),
      hasUser: !!user,
    };
  });
};

// Seuil de signalement : moyenne des derniers scores sous 80 % de l'habitude du joueur.
export const DECLINE_THRESHOLD = 0.8;
// Nombre de derniers scores examinés, et minimum de scores comparables pour signaler quelqu'un
// (un seul mauvais score n'est pas une tendance).
const RECENT_SCORES = 3;
const MIN_RECENT_SAMPLES = 2;
// Seuls les scores des deux derniers cycles commencés comptent comme "récents".
const RECENT_CYCLES = 2;

/**
 * Comptes dont les derniers scores sont nettement sous leur propre habitude. Comme les killers
 * n'ont pas tous la même échelle de points, chaque score récent est comparé à la moyenne du joueur
 * sur le MÊME killer lors des fois précédentes ; un score sans historique sur son killer est ignoré.
 * Retourne les comptes sous `threshold` (ratio moyen), du plus en difficulté au moins en difficulté.
 */
export const getDeclineAlerts = async (db, { guildIds, threshold = DECLINE_THRESHOLD, now = Date.now() }) => {
  const guilds = await db.collection('guildes')
    .find({ _id: { $in: toObjectIds(guildIds) } }, { projection: { name: 1 } })
    .toArray();
  if (guilds.length === 0) return [];

  // Membres actuels (users.bbs_accounts[].guilde_id), avec leur guilde actuelle
  const guildIdStrings = guilds.map((g) => g._id.toString());
  const users = await db.collection('users').find(
    { 'bbs_accounts.guilde_id': { $in: guildIdStrings } },
    { projection: { discord_id: 1, avatar: 1, global_name: 1, bbs_accounts: 1 } }
  ).toArray();
  const members = new Map();
  for (const user of users) {
    for (const account of user.bbs_accounts || []) {
      if (account.bbs_id && guildIdStrings.includes(account.guilde_id)) {
        members.set(account.bbs_id, { user, guildId: account.guilde_id });
      }
    }
  }
  if (members.size === 0) return [];

  const cycles = (await getCyclesChronological(db)).filter((c) => cycleTimestamp(c) <= now);
  const cycleOrder = new Map(cycles.map((c, i) => [c._id.toString(), i]));
  const recentCycleIds = new Set(cycles.slice(-RECENT_CYCLES).map((c) => c._id.toString()));
  const positionIn = new Map();
  const cycleById = new Map();
  for (const c of cycles) {
    cycleById.set(c._id.toString(), c);
    (c.rotations || []).forEach((r, i) => positionIn.set(`${c._id}|${r.rotation_id}`, i));
  }

  const scores = (await loadComparableScores(db, { bbs_id: { $in: [...members.keys()] } }))
    .filter((s) => cycleOrder.has(s.cycle_id))
    .map((s) => ({ ...s, order: cycleOrder.get(s.cycle_id) * 1000 + (positionIn.get(`${s.cycle_id}|${s.rotation_id}`) ?? 0) }))
    .sort((a, b) => a.order - b.order);

  const byAccount = new Map();
  for (const s of scores) {
    if (!byAccount.has(s.bbs_id)) byAccount.set(s.bbs_id, []);
    byAccount.get(s.bbs_id).push(s);
  }

  const alerts = [];
  for (const [bbsId, history] of byAccount) {
    const samples = [];
    for (let i = history.length - 1; i >= 0 && samples.length < RECENT_SCORES; i--) {
      const s = history[i];
      if (!recentCycleIds.has(s.cycle_id)) break;
      const earlier = history.slice(0, i).filter((e) => e.rotation_id === s.rotation_id);
      if (earlier.length === 0) continue;
      const usual = Math.round(earlier.reduce((sum, e) => sum + (e.score || 0), 0) / earlier.length);
      if (usual <= 0) continue;
      samples.push({ score: s, usual });
    }
    if (samples.length < MIN_RECENT_SAMPLES) continue;

    const ratio = samples.reduce((sum, { score, usual }) => sum + (score.score || 0) / usual, 0) / samples.length;
    if (ratio >= threshold) continue;

    const { user, guildId } = members.get(bbsId);
    const latest = samples[0].score;
    alerts.push({
      bbs_id: bbsId,
      bbs_name: latest.bbs_name || null,
      user_id: user._id.toString(),
      discord_id: user.discord_id,
      global_name: user.global_name,
      avatar: user.avatar,
      guild_id: guildId,
      guild_name: guilds.find((g) => g._id.toString() === guildId)?.name || null,
      ratio: Math.round(ratio * 100) / 100,
      drop_percent: Math.round((1 - ratio) * 100),
      samples: samples.map(({ score, usual }) => ({
        cycle_id: score.cycle_id,
        cycle_name: cycleById.get(score.cycle_id)?.name || null,
        cycle_year: cycleById.get(score.cycle_id)?.year || null,
        rotation_id: score.rotation_id,
        score: score.score || 0,
        usual,
      })),
    });
  }

  if (alerts.length === 0) return [];

  // Killer/attaque de chaque rotation échantillonnée, pour l'affichage
  const rotationIds = [...new Set(alerts.flatMap((a) => a.samples.map((s) => s.rotation_id)))];
  const rotations = await db.collection('rotations')
    .find({ _id: { $in: toObjectIds(rotationIds) } }, { projection: { killer: 1, attack: 1, alteration: 1 } })
    .toArray();
  const rotationById = new Map(rotations.map((r) => [r._id.toString(), r]));
  for (const alert of alerts) {
    for (const sample of alert.samples) {
      const rotation = rotationById.get(sample.rotation_id);
      sample.killer = rotation?.killer || null;
      sample.attack = rotation?.attack || null;
      sample.alteration = rotation?.alteration || null;
    }
  }

  return alerts.sort((a, b) => a.ratio - b.ratio);
};

/**
 * Records personnels battus pendant `cycle` par les comptes `bbsIds` : scores du cycle qui
 * dépassent le meilleur score du même compte sur le même killer lors des cycles ANTÉRIEURS.
 */
export const getCycleRecords = async (db, cycle, bbsIds) => {
  const cycleId = cycle._id.toString();
  const rotationIds = (cycle.rotations || []).map((r) => r.rotation_id);
  if (bbsIds.length === 0 || rotationIds.length === 0) return [];

  const cycles = await getCyclesChronological(db);
  const start = cycleTimestamp(cycle);
  const earlierCycleIds = new Set(cycles.filter((c) => cycleTimestamp(c) < start).map((c) => c._id.toString()));

  const scores = await loadComparableScores(db, { bbs_id: { $in: bbsIds }, rotation_id: { $in: rotationIds } });
  const bestBefore = new Map();
  for (const s of scores) {
    if (!earlierCycleIds.has(s.cycle_id)) continue;
    const key = `${s.bbs_id}|${s.rotation_id}`;
    if ((s.score || 0) > (bestBefore.get(key) ?? -Infinity)) bestBefore.set(key, s.score || 0);
  }

  return scores
    .filter((s) => s.cycle_id === cycleId && bestBefore.has(`${s.bbs_id}|${s.rotation_id}`)
      && (s.score || 0) > bestBefore.get(`${s.bbs_id}|${s.rotation_id}`))
    .map((s) => ({
      bbs_id: s.bbs_id,
      pseudo: s.bbs_name || s.bbs_id,
      rotation_id: s.rotation_id,
      previous_score: bestBefore.get(`${s.bbs_id}|${s.rotation_id}`),
      new_score: s.score,
    }))
    .sort((a, b) => (b.new_score - b.previous_score) / b.previous_score - (a.new_score - a.previous_score) / a.previous_score);
};
