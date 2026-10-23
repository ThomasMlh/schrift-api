/**
 * Monthly raffle tickets of a guild, from its scores of the month and the tickets entered by its leaders.
 * Pure: every input is loaded by the caller, so the rules can be tested on their own.
 */

export const RAFFLE_RULES = {
  rotationTop: 5,
  maxRotationTopTickets: 4,
  monthTop: 5,
  homogeneityFull: 100_000,
  homogeneityHalf: 300_000,
  maxSeniorityTickets: 3,
  collectiveGap: 500_000,
  periods: 2,
};

const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

// Rank 1 = best; equal scores share the rank
const rankBy = (entries, value) => {
  const sorted = [...entries].sort((a, b) => value(b) - value(a));
  return new Map(sorted.map((e) => [e, 1 + sorted.filter((o) => value(o) > value(e)).length]));
};

// Worst rotation of the month, measured as the gap below the guild average on that rotation
export const homogeneityTickets = (worstGap) => {
  if (worstGap === null) return 0;
  if (worstGap < RAFFLE_RULES.homogeneityFull) return 2;
  return worstGap <= RAFFLE_RULES.homogeneityHalf ? 1 : 0;
};

/**
 * @param rotations month rotations [{ cycle_id, rotation_id }]
 * @param scores the guild's scores on those rotations [{ bbs_id, bbs_name, cycle_id, rotation_id, score }]
 * @param players extra players to list without scores (current members) [{ bbs_id, bbs_name }]
 * @param firstSeen Map bbs_id -> timestamp of the first known presence in the guilds
 * @param manual tickets entered by leaders [{ bbs_id, kind: 'farm'|'qg'|'bonus', period, count, label }]
 */
export const computeRaffleTickets = ({
  rotations, scores, players = [], firstSeen = new Map(), manual = [], sRank = false, monthEnd, maxTickets = 20,
}) => {
  const rotationKey = (r) => `${r.cycle_id}|${r.rotation_id}`;
  const monthRotations = new Set(rotations.map(rotationKey));
  const monthScores = scores.filter((s) => s.bbs_id && monthRotations.has(rotationKey(s)));

  const byPlayer = new Map();
  const ensure = (bbsId, bbsName) => {
    if (!byPlayer.has(bbsId)) byPlayer.set(bbsId, { bbs_id: bbsId, bbs_name: bbsName ?? null, scores: new Map() });
    const player = byPlayer.get(bbsId);
    if (!player.bbs_name && bbsName) player.bbs_name = bbsName;
    return player;
  };
  for (const s of monthScores) ensure(s.bbs_id, s.bbs_name).scores.set(rotationKey(s), s.score || 0);
  for (const p of players) if (p.bbs_id) ensure(p.bbs_id, p.bbs_name);
  const list = [...byPlayer.values()];

  // Top 5 of each rotation, and gap to the guild average on each rotation
  const rotationTops = new Map(list.map((p) => [p.bbs_id, 0]));
  const worstGaps = new Map(list.map((p) => [p.bbs_id, null]));
  const playedRotations = [...monthRotations].filter((key) => list.some((p) => p.scores.has(key)));
  for (const key of playedRotations) {
    const entries = list.filter((p) => p.scores.has(key));
    const ranks = rankBy(entries, (p) => p.scores.get(key));
    const average = entries.reduce((sum, p) => sum + p.scores.get(key), 0) / entries.length;
    for (const p of entries) {
      if (ranks.get(p) <= RAFFLE_RULES.rotationTop) rotationTops.set(p.bbs_id, rotationTops.get(p.bbs_id) + 1);
      const gap = average - p.scores.get(key);
      worstGaps.set(p.bbs_id, Math.max(worstGaps.get(p.bbs_id) ?? -Infinity, gap));
    }
  }

  // A missed rotation is the worst possible one
  const playedAll = (p) => playedRotations.every((key) => p.scores.has(key));

  // Monthly top 5 and collective gap: average over the month, for players with at least half of the rotations
  const minRotations = Math.ceil(playedRotations.length / 2);
  const ranked = list
    .filter((p) => playedRotations.length > 0 && p.scores.size >= minRotations)
    .map((p) => ({ player: p, average: [...p.scores.values()].reduce((a, b) => a + b, 0) / p.scores.size }));
  const monthRanks = rankBy(ranked, (e) => e.average);
  const monthTop = new Set(ranked.filter((e) => monthRanks.get(e) <= RAFFLE_RULES.monthTop).map((e) => e.player.bbs_id));
  const averages = ranked.map((e) => e.average);
  const collectiveGap = averages.length > 1 ? Math.max(...averages) - Math.min(...averages) : null;
  const tightGuild = collectiveGap !== null && collectiveGap < RAFFLE_RULES.collectiveGap;

  const manualOf = (bbsId, kind) => manual.filter((m) => m.bbs_id === bbsId && m.kind === kind);

  const results = list.map((p) => {
    const top5Rotations = Math.min(rotationTops.get(p.bbs_id), RAFFLE_RULES.maxRotationTopTickets);
    const top5Month = monthTop.has(p.bbs_id) ? 1 : 0;
    const worstGap = playedRotations.length > 0 && playedAll(p) ? worstGaps.get(p.bbs_id) : null;
    const since = firstSeen.get(p.bbs_id);
    const years = since && monthEnd ? Math.floor((monthEnd - since) / YEAR_MS) : 0;
    // Seniority only counts for players who earned a top 5 ticket this month
    const seniority = top5Rotations + top5Month > 0 ? Math.min(years, RAFFLE_RULES.maxSeniorityTickets) : 0;
    const farmPeriods = new Set(manualOf(p.bbs_id, 'farm').map((m) => m.period));
    const qgPeriods = new Set(manualOf(p.bbs_id, 'qg').map((m) => m.period));
    const bonusEntries = manualOf(p.bbs_id, 'bonus');

    const breakdown = {
      top5_rotations: top5Rotations,
      top5_month: top5Month,
      homogeneity: homogeneityTickets(worstGap),
      seniority,
      s_rank: sRank ? 1 : 0,
      collective_gap: tightGuild ? 1 : 0,
      farm: Math.min(farmPeriods.size, RAFFLE_RULES.periods),
      qg: Math.min(qgPeriods.size, RAFFLE_RULES.periods),
      bonus: bonusEntries.reduce((sum, m) => sum + (m.count || 0), 0),
    };
    const earned = Object.values(breakdown).reduce((a, b) => a + b, 0);

    return {
      bbs_id: p.bbs_id,
      bbs_name: p.bbs_name,
      rotations_played: p.scores.size,
      worst_gap: worstGap === null ? null : Math.round(worstGap),
      years,
      breakdown,
      farm_periods: [...farmPeriods].sort(),
      qg_periods: [...qgPeriods].sort(),
      bonuses: bonusEntries.map((m) => ({ _id: m._id, label: m.label, count: m.count })),
      earned,
      tickets: Math.min(earned, maxTickets),
    };
  });

  results.sort((a, b) => b.tickets - a.tickets || (a.bbs_name ?? '').localeCompare(b.bbs_name ?? ''));
  return {
    rotations: playedRotations.length,
    collective_gap: collectiveGap === null ? null : Math.round(collectiveGap),
    total_tickets: results.reduce((sum, r) => sum + r.tickets, 0),
    players: results,
  };
};

// Weighted draw: ticket number `pick` (0-based) among the players in the given order
export const pickWinner = (players, pick) => {
  let remaining = pick;
  for (const p of players) {
    if (remaining < p.tickets) return p;
    remaining -= p.tickets;
  }
  return null;
};
