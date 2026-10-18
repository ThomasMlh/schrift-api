import { getGameMonths } from '../../src/services/podiumService/index.js';

const rotation = (position, start_date, end_date) => ({ position, rotation_id: `r${position}`, start_date, end_date });

// Weekly pairs as stored: Tuesday-Thursday then Friday-Sunday (really Monday-Thursday then Thursday-Sunday)
const cycle4 = {
  _id: 'c4',
  rotations: [
    rotation(1, '25/08/2026', '27/08/2026'), rotation(2, '28/08/2026', '30/08/2026'),
    rotation(3, '01/09/2026', '03/09/2026'), rotation(4, '04/09/2026', '06/09/2026'),
    rotation(11, '29/09/2026', '01/10/2026'), rotation(12, '02/10/2026', '04/10/2026'),
    rotation(13, '06/10/2026', '08/10/2026'), rotation(14, '09/10/2026', '11/10/2026'),
    rotation(19, '27/10/2026', '29/10/2026'), rotation(20, '30/10/2026', '01/11/2026'),
  ],
};
const cycle5 = {
  _id: 'c5',
  rotations: [rotation(1, '03/11/2026', '05/11/2026'), rotation(2, '06/11/2026', '08/11/2026')],
};

describe('getGameMonths', () => {
  const now = new Date(2026, 9, 18).getTime();
  const months = getGameMonths([cycle4, cycle5], now);
  const byKey = Object.fromEntries(months.map((m) => [m.key, m]));

  it('assigns a week overlapping two months to the month it starts in', () => {
    expect(byKey['2026-09'].rotations.map((r) => r.rotation_id)).toEqual(['r11', 'r12']);
    expect(byKey['2026-10'].rotations.map((r) => r.rotation_id)).toEqual(['r13', 'r14', 'r19', 'r20']);
  });

  it('uses the real start of the week, the day before the stored date', () => {
    // Stored Tuesday 01/09 really starts on Monday 31/08: the week belongs to August
    expect(byKey['2026-08'].rotations.map((r) => r.rotation_id)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(byKey['2026-09'].start_date).toBe('28/09/2026');
  });

  it('exposes the period, the number of weeks and the progress state', () => {
    expect(byKey['2026-10']).toMatchObject({ start_date: '05/10/2026', end_date: '01/11/2026', weeks: 2, in_progress: true });
    expect(byKey['2026-09'].in_progress).toBe(false);
  });

  it('spans several cycles and sorts months from the most recent', () => {
    expect(byKey['2026-11'].rotations).toEqual([
      expect.objectContaining({ cycle_id: 'c5', rotation_id: 'r1' }),
      expect.objectContaining({ cycle_id: 'c5', rotation_id: 'r2' }),
    ]);
    expect(months.map((m) => m.key)).toEqual(['2026-11', '2026-10', '2026-09', '2026-08']);
  });

  it('ignores rotations without a date', () => {
    expect(getGameMonths([{ _id: 'c', rotations: [{ rotation_id: 'x' }] }])).toEqual([]);
  });
});
