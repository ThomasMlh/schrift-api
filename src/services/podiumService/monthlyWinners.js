import { getGameMonths } from './gameMonths.js';

const TOP_PLAYERS = 3;

const scaledMinimum = (minScoresPerCycle, rotations, cycleLength) => (
  minScoresPerCycle > 0 ? Math.ceil((minScoresPerCycle * rotations) / Math.max(1, cycleLength)) : 0
);

/**
 * Winners of each finished game month, most recent first: the top players by average (same rule
 * as the monthly podium, threshold scaled to the month) and the guild with the best average.
 * Several players share the title on a tie.
 * scores: [{ bbs_id, bbs_name, user_id, cycle_id, rotation_id, guild_id, score }]
 */
export const computeMonthlyWinners = ({ cycles, scores, minScoresPerCycle = 0, activeGuildIds = null, now = Date.now() }) => {
  const months = getGameMonths(cycles, now).filter((m) => m.finished);
  const monthByRotation = new Map();
  for (const month of months) {
    for (const { cycle_id, rotation_id } of month.rotations) monthByRotation.set(`${cycle_id}|${rotation_id}`, month.key);
  }

  const totals = new Map(); // month key -> { players: Map, guilds: Map }
  for (const s of scores) {
    const key = monthByRotation.get(`${s.cycle_id}|${s.rotation_id}`);
    if (!key || !s.bbs_id || typeof s.score !== 'number') continue;
    const entry = totals.get(key) ?? { players: new Map(), guilds: new Map() };
    const player = entry.players.get(s.bbs_id) ?? { bbs_id: s.bbs_id, sum: 0, count: 0, guilds: new Map() };
    player.sum += s.score;
    player.count += 1;
    player.bbs_name = s.bbs_name || player.bbs_name;
    player.user_id = s.user_id || player.user_id;
    if (s.guild_id) player.guilds.set(s.guild_id, (player.guilds.get(s.guild_id) || 0) + 1);
    entry.players.set(s.bbs_id, player);
    if (s.guild_id && (!activeGuildIds || activeGuildIds.has(s.guild_id))) {
      const guild = entry.guilds.get(s.guild_id) ?? { guild_id: s.guild_id, sum: 0, count: 0 };
      guild.sum += s.score;
      guild.count += 1;
      entry.guilds.set(s.guild_id, guild);
    }
    totals.set(key, entry);
  }

  const cycleLength = Math.max(1, ...cycles.map((c) => c.rotations?.length || 0));
  return months.flatMap((month) => {
    const entry = totals.get(month.key);
    if (!entry) return [];
    const minimum = scaledMinimum(minScoresPerCycle, month.rotations.length, cycleLength);
    const ranked = [...entry.players.values()]
      .filter((p) => p.count >= minimum)
      .map((p) => ({
        bbs_id: p.bbs_id,
        bbs_name: p.bbs_name ?? null,
        user_id: p.user_id ?? null,
        guild_id: [...p.guilds].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
        averageScore: Math.round(p.sum / p.count),
        totalScores: p.count,
      }))
      .sort((a, b) => b.averageScore - a.averageScore);

    let rank = 0;
    const players = ranked
      .map((p, i) => {
        if (i === 0 || p.averageScore !== ranked[i - 1].averageScore) rank = i + 1;
        return { ...p, rank };
      })
      .filter((p) => p.rank <= TOP_PLAYERS);
    const bestGuild = [...entry.guilds.values()]
      .map((g) => ({ guild_id: g.guild_id, averageScore: Math.round(g.sum / g.count), totalScores: g.count }))
      .sort((a, b) => b.averageScore - a.averageScore)[0] ?? null;

    return [{
      key: month.key,
      start_date: month.start_date,
      end_date: month.end_date,
      ends_at: month.ends_at,
      players,
      guild: bestGuild,
    }];
  });
};
