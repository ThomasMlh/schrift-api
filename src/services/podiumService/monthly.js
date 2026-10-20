import { parseDate } from '../killerRecords.js';
import { attachTopAchievements } from './achievementBadges.js';
import {
  getMinScoresForRanking, getGuildScoreMatch, lookupUserAndGuild, overrideGuildName, applyRanks, paginate, keepBbsIds,
} from './helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;

const pad = (n) => String(n).padStart(2, '0');
const formatDate = (ts) => {
  const d = new Date(ts);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
};
// Stored start dates are one day late: a rotation really starts the day before (front:
// getRotationRealDates), so game weeks run Monday to Sunday.
const realStartOf = (startDate) => {
  const stored = parseDate(startDate);
  if (!stored) return 0;
  const d = new Date(stored);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1).getTime();
};
const mondayOf = (ts) => {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
};

// Rotations grouped into game weeks (Monday to Sunday with real dates), and each week assigned to
// the month of its first day. A week overlapping two months therefore counts once, in
// the month it starts.
export const getGameMonths = (cycles, now = Date.now()) => {
  const weeks = new Map();
  for (const cycle of cycles) {
    for (const rotation of cycle.rotations || []) {
      const start = realStartOf(rotation.start_date);
      if (!start || !rotation.rotation_id) continue;
      const end = parseDate(rotation.end_date) || start;
      const key = mondayOf(start);
      const week = weeks.get(key) ?? { start, end, rotations: [] };
      week.start = Math.min(week.start, start);
      week.end = Math.max(week.end, end);
      week.rotations.push({ cycle_id: cycle._id.toString(), rotation_id: rotation.rotation_id, start });
      weeks.set(key, week);
    }
  }

  const months = new Map();
  for (const week of weeks.values()) {
    const d = new Date(week.start);
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    const month = months.get(key) ?? { key, start: week.start, end: week.end, weeks: 0, rotations: [] };
    month.start = Math.min(month.start, week.start);
    month.end = Math.max(month.end, week.end);
    month.weeks += 1;
    month.rotations.push(...week.rotations);
    months.set(key, month);
  }

  return [...months.values()]
    .sort((a, b) => b.start - a.start)
    .map((m) => ({
      key: m.key,
      start_date: formatDate(m.start),
      end_date: formatDate(m.end),
      weeks: m.weeks,
      in_progress: m.start <= now && now < m.end + DAY_MS,
      rotations: m.rotations,
    }));
};

const loadCycles = (db) => db.collection('cycles').find({}, { projection: { rotations: 1 } }).toArray();

// Available months, most recent first (without the rotation details)
export const getPodiumMonths = async (db) => {
  const months = getGameMonths(await loadCycles(db));
  return { months: months.map(({ rotations, ...month }) => ({ ...month, rotations: rotations.length })) };
};

// Score filter matching the rotations of a game month, or null when the month has no guild week
export const getMonthScoreFilter = async (db, monthKey) => {
  const target = getGameMonths(await loadCycles(db)).find((m) => m.key === monthKey);
  if (!target) return null;
  const rotationsByCycle = new Map();
  for (const { cycle_id, rotation_id } of target.rotations) {
    rotationsByCycle.set(cycle_id, [...(rotationsByCycle.get(cycle_id) ?? []), rotation_id]);
  }
  return {
    $or: [...rotationsByCycle].map(([cycleId, rotationIds]) => ({ cycle_id: cycleId, rotation_id: { $in: rotationIds } })),
  };
};

// Monthly podium: average (or total) of the scores of every rotation of the month's weeks, across
// cycles. Without a month, the month in progress (or the most recent one) is used.
export const getPodiumMonthly = async (db, { month, ranking_type = 'average', guild_name, bbs_ids, page = 1, limit = 50 }) => {
  if (month && !MONTH_KEY.test(month)) {
    const err = new Error('month doit être au format AAAA-MM');
    err.statusCode = 400;
    throw err;
  }
  const rankingType = String(ranking_type).toLowerCase();
  if (!['average', 'max'].includes(rankingType)) {
    const err = new Error('ranking_type doit être "average" ou "max"');
    err.statusCode = 400;
    throw err;
  }

  const pageNumber = Math.max(1, parseInt(page, 10) || 1);
  const limitNumber = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

  const cycles = await loadCycles(db);
  const months = getGameMonths(cycles);
  const target = month ? months.find((m) => m.key === month) : (months.find((m) => m.in_progress) ?? months[0]);
  if (!target) {
    const err = new Error(month ? `Aucune semaine de guilde en ${month}` : 'Aucun mois disponible');
    err.statusCode = 404;
    throw err;
  }

  let guild = null;
  if (guild_name?.trim()) {
    guild = await db.collection('guildes').findOne({ name: guild_name.trim() });
    if (!guild) {
      const err = new Error(`Guilde avec le nom "${guild_name}" non trouvée`);
      err.statusCode = 404;
      throw err;
    }
  }

  const rotationsByCycle = new Map();
  for (const { cycle_id, rotation_id } of target.rotations) {
    rotationsByCycle.set(cycle_id, [...(rotationsByCycle.get(cycle_id) ?? []), rotation_id]);
  }

  // The guild scope follows the cycle podium rule, cycle by cycle (current members on a running
  // cycle, the score's guild on a finished one)
  const cycleClauses = await Promise.all([...rotationsByCycle].map(async ([cycleId, rotationIds]) => {
    const clause = { cycle_id: cycleId, rotation_id: { $in: rotationIds } };
    if (!guild) return clause;
    const cycle = cycles.find((c) => c._id.toString() === cycleId);
    return { ...clause, ...(await getGuildScoreMatch(db, cycle, guild._id.toString())) };
  }));

  // The admin threshold is set for a full cycle: scaled to the rotations of the month already started
  const minScoresPerCycle = rankingType === 'average' ? await getMinScoresForRanking(db) : 0;
  const cycleLength = Math.max(1, ...cycles.map((c) => c.rotations?.length || 0));
  const startedRotations = target.rotations.filter((r) => r.start <= Date.now()).length;
  const minScores = minScoresPerCycle > 0 ? Math.ceil((minScoresPerCycle * startedRotations) / cycleLength) : 0;

  const scoreKey = rankingType === 'max' ? 'totalScore' : 'averageScore';
  const pipeline = [
    { $match: { bbs_id: { $ne: null }, $or: cycleClauses } },
    {
      $group: {
        _id: '$bbs_id',
        user_id: { $first: '$user_id' },
        bbs_name: { $first: '$bbs_name' },
        guild_id: { $first: '$guild_id' },
        averageScore: { $avg: '$score' },
        totalScore: { $sum: '$score' },
        totalScores: { $sum: 1 },
      }
    },
    ...(minScores > 0 ? [{ $match: { totalScores: { $gte: minScores } } }] : []),
    ...lookupUserAndGuild(),
    {
      $project: {
        _id: 0,
        bbs_id: '$_id',
        user_id: 1,
        bbs_name: 1,
        discord_id: { $arrayElemAt: ['$user.discord_id', 0] },
        global_name: { $arrayElemAt: ['$user.global_name', 0] },
        averageScore: { $round: ['$averageScore', 0] },
        totalScore: { $round: ['$totalScore', 0] },
        totalScores: 1,
        avatar: { $arrayElemAt: ['$user.avatar', 0] },
        guild_name: { $arrayElemAt: ['$guild.name', 0] },
        hasUser: 1
      }
    },
    { $sort: { [scoreKey]: -1 } }
  ];

  const allResults = await db.collection('scores').aggregate(pipeline).toArray();
  overrideGuildName(allResults, guild?.name);
  const { items: data, pagination } = paginate(keepBbsIds(applyRanks(allResults, scoreKey), bbs_ids), pageNumber, limitNumber);
  await attachTopAchievements(db, data);

  return {
    data,
    pagination,
    filters: {
      month: target.key,
      guild_name: guild_name || null,
      ranking_type: rankingType
    },
    meta: {
      totalPlayers: pagination.totalCount,
      guildSpecific: !!guild,
      fullPodium: true,
      podiumType: rankingType === 'max' ? 'max_scores' : 'average_scores',
      monthInfo: {
        key: target.key,
        start_date: target.start_date,
        end_date: target.end_date,
        weeks: target.weeks,
        rotations: target.rotations.length,
        in_progress: target.in_progress
      },
      ...(minScores > 0 && { minScoresRequired: minScores })
    }
  };
};

// Average of a bbs account per game month (same week grouping as the monthly podium), oldest first
export const getPlayerMonthlyAverages = async (db, bbsId) => {
  const months = getGameMonths(await loadCycles(db));
  const monthByRotation = new Map();
  for (const month of months) {
    for (const { cycle_id, rotation_id } of month.rotations) monthByRotation.set(`${cycle_id}|${rotation_id}`, month);
  }

  const scores = await db.collection('scores')
    .find({ bbs_id: bbsId }, { projection: { cycle_id: 1, rotation_id: 1, score: 1 } })
    .toArray();

  const totals = new Map();
  for (const { cycle_id, rotation_id, score } of scores) {
    const month = monthByRotation.get(`${cycle_id}|${rotation_id}`);
    if (!month || typeof score !== 'number') continue;
    const entry = totals.get(month.key) ?? { month, sum: 0, count: 0 };
    entry.sum += score;
    entry.count += 1;
    totals.set(month.key, entry);
  }

  return [...totals.values()]
    .sort((a, b) => a.month.key.localeCompare(b.month.key))
    .map(({ month, sum, count }) => ({
      key: month.key,
      start_date: month.start_date,
      end_date: month.end_date,
      in_progress: month.in_progress,
      averageScore: Math.round(sum / count),
      scoreCount: count,
    }));
};
