import { parseDate } from '../killerRecords.js';

export const DAY_MS = 24 * 60 * 60 * 1000;

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
      finished: m.end + DAY_MS <= now,
      ends_at: m.end,
      rotations: m.rotations,
    }));
};

