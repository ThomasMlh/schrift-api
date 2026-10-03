import { notifyDiscord } from '../utils/notifyDiscord.js';
import { logger } from '../utils/logger.js';
import { loadComparableScores, cycleTimestamp, parseDate, toObjectIds, average } from './killerRecords.js';
import { getProgression, getPreviousCycle, getCyclesChronological } from './playerTrends.js';
import { getPodiumFull, getCurrentGuildBbsIds, getMinScoresForRanking } from './podiumService/index.js';

// Nombre maximum de records listés dans le message (le total est toujours indiqué).
const MAX_LISTED_RECORDS = 8;
// L'envoi automatique ne rattrape que les cycles terminés depuis peu, pour ne pas publier d'un
// coup le récap de tous les anciens cycles le jour où l'option est activée.
const AUTO_RECAP_MAX_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Records personnels battus pendant `cycle` par les comptes `bbsIds` : scores du cycle qui
 * dépassent le meilleur score du même compte sur le même killer lors des cycles ANTÉRIEURS.
 */
const getCycleRecords = async (db, cycle, bbsIds) => {
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

/**
 * Bilan d'un cycle pour une guilde (membres actuels) : top 3 (même classement que le podium
 * publié), records personnels battus, plus forte progression et moyenne de la guilde comparée
 * au cycle précédent.
 */
export const getCycleRecap = async (db, cycle, guild) => {
  const guildId = guild._id.toString();
  const bbsIds = await getCurrentGuildBbsIds(db, guildId);
  const minScores = await getMinScoresForRanking(db);
  const previousCycle = await getPreviousCycle(db, cycle._id);

  const [podium, records, progression, currentScores, previousScores] = await Promise.all([
    getPodiumFull(db, { cycle_name: cycle.name, year: cycle.year, guild_name: guild.name, ranking_type: 'average', limit: 3 }),
    getCycleRecords(db, cycle, bbsIds),
    getProgression(db, { cycle, bbsIds, minScores }),
    loadComparableScores(db, { cycle_id: cycle._id.toString(), bbs_id: { $in: bbsIds } }),
    previousCycle ? loadComparableScores(db, { cycle_id: previousCycle._id.toString(), bbs_id: { $in: bbsIds } }) : [],
  ]);

  const rotationIds = [...new Set(records.map((r) => r.rotation_id))];
  const rotations = rotationIds.length
    ? await db.collection('rotations').find({ _id: { $in: toObjectIds(rotationIds) } }, { projection: { killer: 1, attack: 1 } }).toArray()
    : [];
  const rotationById = new Map(rotations.map((r) => [r._id.toString(), r]));

  const best = progression.rows[0];
  return {
    guild_name: guild.name,
    cycle_name: cycle.name,
    cycle_year: cycle.year,
    previous_cycle_name: previousCycle?.name || null,
    participants: new Set(currentScores.map((s) => s.bbs_id)).size,
    top3: podium.data.filter((p) => p.rank <= 3).map((p) => ({ rank: p.rank, pseudo: p.bbs_name, average: p.averageScore })),
    records_count: records.length,
    records: records.slice(0, MAX_LISTED_RECORDS).map((r) => ({
      pseudo: r.pseudo,
      killer: rotationById.get(r.rotation_id)?.killer || '',
      attack: rotationById.get(r.rotation_id)?.attack || '',
      previous_score: r.previous_score,
      new_score: r.new_score,
    })),
    best_progression: best && best.progression > 0
      ? { pseudo: best.bbs_name, previous_average: best.previousAverageScore, average: best.averageScore, percent: best.progressionPercent }
      : null,
    guild_average: average(currentScores),
    previous_guild_average: average(previousScores),
  };
};

const cycleSlugOf = (cycle) => `${(cycle.name || '').toLowerCase().replace(/\s+/g, '-')}-${cycle.year}`;

/**
 * Publie le récap d'un cycle dans le salon général de chaque guilde (salon chefs à défaut) :
 * capture du podium et/ou bilan écrit. Les envois sont attendus (Promise.all) : sur Vercel,
 * l'exécution peut être coupée dès la réponse envoyée. Marque le cycle comme publié pour que
 * l'envoi automatique ne le republie pas.
 */
export const publishCycleRecap = async (db, cycle, guilds, { rankingType = 'average', includeSnapshot = true, includeSummary = true } = {}) => {
  const frontendUrl = process.env.FRONTEND_URL?.replace(/\/$/, '');

  const results = await Promise.all(guilds.map(async (guild) => {
    const channelId = guild.discord_general_channel_id || guild.discord_channel_id;
    if (!channelId) return { guild: guild.name, status: 'skipped', reason: 'Aucun salon Discord configuré' };

    try {
      if (includeSnapshot && frontendUrl) {
        const captureUrl = `${frontendUrl}/podium?capture=1&mode=cycle`
          + `&ranking_type=${encodeURIComponent(rankingType)}&cycle_name=${encodeURIComponent(cycleSlugOf(cycle))}`
          + `&guild_name=${encodeURIComponent(guild.name)}`;
        await notifyDiscord('podium_snapshot', { guild_name: guild.name, cycle_name: cycle.name, podium_url: captureUrl }, channelId);
      }
      if (includeSummary) {
        await notifyDiscord('cycle_recap', await getCycleRecap(db, cycle, guild), channelId);
      }
      return { guild: guild.name, status: 'requested' };
    } catch (err) {
      logger.error(`[cycleRecap] Échec du récap pour la guilde ${guild.name}:`, err.message);
      return { guild: guild.name, status: 'error', reason: err.message };
    }
  }));

  await db.collection('cycles').updateOne({ _id: cycle._id }, { $set: { recap_published_at: new Date() } });
  return results;
};

/** Date de fin d'un cycle (fin de sa dernière rotation), en ms. */
const cycleEndTimestamp = (cycle) => parseDate(cycle.rotations?.at(-1)?.end_date);

/**
 * Envoi automatique (cron quotidien) : publie le récap des cycles terminés depuis moins de
 * AUTO_RECAP_MAX_AGE_DAYS jours et pas encore publiés, si l'option est activée par un admin.
 */
export const publishPendingCycleRecaps = async (db, now = Date.now()) => {
  const settings = await db.collection('app_settings').findOne({ _id: 'podium' });
  if (!settings?.auto_cycle_recap) return { enabled: false, published: [] };

  const cycles = await db.collection('cycles').find({ recap_published_at: { $exists: false } }).toArray();
  const ended = cycles.filter((c) => {
    const end = cycleEndTimestamp(c);
    // end_date est le dernier jour de la rotation : le cycle est terminé le lendemain
    return end > 0 && end + DAY_MS <= now && now - end <= AUTO_RECAP_MAX_AGE_DAYS * DAY_MS;
  });
  if (ended.length === 0) return { enabled: true, published: [] };

  const guilds = await db.collection('guildes').find({ disabled: { $ne: true } }).toArray();
  const published = [];
  for (const cycle of ended) {
    const results = await publishCycleRecap(db, cycle, guilds);
    published.push({ cycle: cycle.name, year: cycle.year, results });
  }
  return { enabled: true, published };
};
