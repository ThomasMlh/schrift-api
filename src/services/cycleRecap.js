import { notifyDiscord } from '../utils/notifyDiscord.js';
import { logger } from '../utils/logger.js';
import { loadComparableScores, toObjectIds, average } from './killerRecords.js';
import { getProgression, getPreviousCycle, getCycleRecords } from './playerTrends.js';
import { getPodiumFull, getGuildBbsIdsForCycle, getGuildScoreMatch, getMinScoresForRanking } from './podiumService/index.js';
import { getGuildGoals } from './guildGoals.js';

// Maximum number of records listed in the message (the total is always shown).
const MAX_LISTED_RECORDS = 8;

/**
 * A guild's cycle recap: top 3 (same ranking as the published podium), personal records beaten,
 * biggest progression and guild average compared with the previous cycle. Same scope as the podium:
 * current members while the cycle is running, otherwise the scores entered for the guild.
 */
export const getCycleRecap = async (db, cycle, guild) => {
  const guildId = guild._id.toString();
  const bbsIds = await getGuildBbsIdsForCycle(db, cycle, guildId);
  const minScores = await getMinScoresForRanking(db);
  const previousCycle = await getPreviousCycle(db, cycle._id);
  const [currentMatch, previousMatch] = await Promise.all([
    getGuildScoreMatch(db, cycle, guildId),
    previousCycle ? getGuildScoreMatch(db, previousCycle, guildId) : null,
  ]);

  const [podium, records, progression, currentScores, previousScores, goals] = await Promise.all([
    getPodiumFull(db, { cycle_name: cycle.name, year: cycle.year, guild_name: guild.name, ranking_type: 'average', limit: 3 }),
    getCycleRecords(db, cycle, bbsIds),
    getProgression(db, { cycle, bbsIds, minScores }),
    loadComparableScores(db, { cycle_id: cycle._id.toString(), ...currentMatch }),
    previousCycle ? loadComparableScores(db, { cycle_id: previousCycle._id.toString(), ...previousMatch }) : [],
    getGuildGoals(db, cycle, guildId),
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
    goals: goals.goals.map(({ type, unit, target, value, achieved }) => ({ type, unit, target, value, achieved })),
  };
};

const cycleSlugOf = (cycle) => `${(cycle.name || '').toLowerCase().replace(/\s+/g, '-')}-${cycle.year}`;

/**
 * Publishes a cycle recap in each guild's general channel (leaders channel as a fallback): podium
 * capture and/or written summary. Sends are awaited (Promise.all): on Vercel, execution may stop
 * once the response is sent.
 */
export const publishCycleRecap = async (db, cycle, guilds, { rankingType = 'average', includeSnapshot = true, includeSummary = true } = {}) => {
  const frontendUrl = process.env.FRONTEND_URL?.replace(/\/$/, '');

  return Promise.all(guilds.map(async (guild) => {
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
};
