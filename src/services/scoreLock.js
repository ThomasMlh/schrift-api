import { ObjectId } from 'mongodb';
import { parseDate } from './killerRecords.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Days after the end of a cycle during which leaders/officers can still change its scores.
// Admins are never locked out. 0 = never locked.
export const DEFAULT_SCORE_LOCK_DAYS = 3;

export const getScoreLockDays = async (db) => {
  const settings = await db.collection('app_settings').findOne({ _id: 'scores' });
  return typeof settings?.lock_after_days === 'number' ? settings.lock_after_days : DEFAULT_SCORE_LOCK_DAYS;
};

const cycleEnd = (cycle) => {
  const last = cycle?.rotations?.[cycle.rotations.length - 1];
  return parseDate(last?.end_date) || parseDate(last?.start_date);
};

// Locked once the last rotation's day and the grace period are over
export const isCycleLocked = (cycle, lockDays, now = Date.now()) => {
  if (!lockDays || lockDays <= 0) return false;
  const end = cycleEnd(cycle);
  return end > 0 && now >= end + DAY_MS + lockDays * DAY_MS;
};

// Answers 403 and returns true when a leader/officer targets a locked cycle (req.user set by
// requireScoresAccess)
export const rejectLockedCycles = async (req, res, cycleIds) => {
  if (req.user?.hasFullAccess) return false;
  const ids = [...new Set(cycleIds.filter((id) => id && ObjectId.isValid(id)).map(String))];
  if (ids.length === 0) return false;

  const lockDays = await getScoreLockDays(req.db);
  if (lockDays <= 0) return false;
  const cycles = await req.db.collection('cycles')
    .find({ _id: { $in: ids.map((id) => new ObjectId(id)) } }, { projection: { name: 1, year: 1, rotations: 1 } })
    .toArray();
  const locked = cycles.find((cycle) => isCycleLocked(cycle, lockDays));
  if (!locked) return false;

  res.status(403).json({
    success: false,
    code: 'CYCLE_LOCKED',
    message: `Le cycle ${[locked.name, locked.year].filter(Boolean).join(' ')} est verrouillé : seuls les admins peuvent encore modifier ses scores.`,
  });
  return true;
};
