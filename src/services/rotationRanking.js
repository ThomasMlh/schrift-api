import { USER_SCORES_LOOKUP } from '../utils/projections.js';
import { cycleTimestamp, loadComparableScores, toObjectIds } from './killerRecords.js';

/**
 * Scores of a rotation in one cycle, best first, with their rank (ties share it) and their player.
 * guildId keeps the scores entered for that guild.
 */
export const rankRotationScores = async (db, { cycleId, rotationId, guildId }) => {
  const match = { rotation_id: rotationId, cycle_id: cycleId, ...(guildId && { guild_id: guildId }) };
  const scores = await db.collection('scores').aggregate([
    { $match: match },
    {
      $lookup: {
        from: 'users',
        let: { userId: '$user_id' },
        pipeline: [
          {
            $match: {
              $expr: {
                $or: [
                  { $eq: ['$discord_id', '$$userId'] },
                  { $eq: [{ $toString: '$_id' }, '$$userId'] },
                ],
              },
            },
          },
          { $project: USER_SCORES_LOOKUP },
        ],
        as: 'user',
      },
    },
    { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
    { $sort: { score: -1 } },
  ]).toArray();

  let rank = 1;
  return scores.map((score, index) => {
    if (index > 0 && score.score !== scores[index - 1].score) rank = index + 1;
    return { ...score, rank };
  });
};

const loadCycles = (db, ids) => db.collection('cycles')
  .find({ _id: { $in: toObjectIds(ids) } }, { projection: { name: 1, year: 1, rotations: 1, created_at: 1 } })
  .toArray();

/**
 * Score of each account on its last earlier passage of the rotation (the latest cycle before cycleId
 * where it has a comparable score): bbs_id -> { score, cycle_id, cycle_name, cycle_year }
 */
export const previousPassageScores = async (db, { cycleId, rotationId, bbsIds }) => {
  const ids = [...new Set(bbsIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const scores = await loadComparableScores(db, { rotation_id: rotationId, bbs_id: { $in: ids }, cycle_id: { $ne: cycleId } });
  const cycles = await loadCycles(db, [cycleId, ...new Set(scores.map((s) => s.cycle_id))]);
  const timeOf = new Map(cycles.map((c) => [c._id.toString(), cycleTimestamp(c)]));
  const cycleOf = new Map(cycles.map((c) => [c._id.toString(), c]));
  const currentTime = timeOf.get(cycleId);
  if (currentTime === undefined) return new Map();

  const previous = new Map();
  for (const score of scores) {
    const time = timeOf.get(score.cycle_id);
    if (time === undefined || time >= currentTime || !(score.score > 0)) continue;
    const kept = previous.get(score.bbs_id);
    const keptTime = kept ? timeOf.get(kept.cycle_id) : -Infinity;
    if (time > keptTime || (time === keptTime && score.score > kept.score)) {
      previous.set(score.bbs_id, { score: score.score, cycle_id: score.cycle_id });
    }
  }
  return new Map([...previous].map(([bbsId, entry]) => {
    const cycle = cycleOf.get(entry.cycle_id);
    return [bbsId, { ...entry, cycle_name: cycle?.name ?? null, cycle_year: cycle?.year ?? null }];
  }));
};

/**
 * Best score of each account on the rotation over every cycle, best first, with the cycle it was set
 * in and the number of passages the account played. guildId keeps the scores entered for that guild.
 */
export const getRotationRecords = async (db, rotationId, { guildId } = {}) => {
  const scores = (await loadComparableScores(db, { rotation_id: rotationId, ...(guildId && { guild_id: guildId }) }))
    .filter((s) => s.score > 0);
  const cycles = await loadCycles(db, [...new Set(scores.map((s) => s.cycle_id))]);
  const cycleOf = new Map(cycles.map((c) => [c._id.toString(), c]));
  const guilds = await db.collection('guildes')
    .find({ _id: { $in: toObjectIds([...new Set(scores.map((s) => s.guild_id).filter(Boolean))]) } }, { projection: { name: 1 } })
    .toArray();
  const guildName = new Map(guilds.map((g) => [g._id.toString(), g.name]));

  const byAccount = new Map();
  for (const score of scores) {
    const entry = byAccount.get(score.bbs_id) ?? { best: score, cycles: new Set() };
    entry.cycles.add(score.cycle_id);
    if (score.score > entry.best.score) entry.best = score;
    byAccount.set(score.bbs_id, entry);
  }

  const records = [...byAccount.values()]
    .sort((a, b) => b.best.score - a.best.score)
    .map(({ best, cycles: played }) => ({
      bbs_id: best.bbs_id,
      bbs_name: best.bbs_name || null,
      score: best.score,
      guild_id: best.guild_id || null,
      guild_name: guildName.get(best.guild_id) || null,
      cycle_id: best.cycle_id,
      cycle_name: cycleOf.get(best.cycle_id)?.name ?? null,
      cycle_year: cycleOf.get(best.cycle_id)?.year ?? null,
      passages: played.size,
    }));

  let rank = 1;
  return records.map((record, index) => {
    if (index > 0 && record.score !== records[index - 1].score) rank = index + 1;
    return { ...record, rank };
  });
};
