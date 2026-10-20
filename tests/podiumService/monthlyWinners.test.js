import { computeMonthlyWinners } from '../../src/services/podiumService/index.js';

const rotation = (position, start_date, end_date) => ({ position, rotation_id: `r${position}`, start_date, end_date });

// September 2026 = the week of 28/09 (r1, r2); October = the weeks of 05/10 and 12/10 (r3 to r6)
const cycle = {
  _id: 'c1',
  rotations: [
    rotation(1, '29/09/2026', '01/10/2026'), rotation(2, '02/10/2026', '04/10/2026'),
    rotation(3, '06/10/2026', '08/10/2026'), rotation(4, '09/10/2026', '11/10/2026'),
    rotation(5, '13/10/2026', '15/10/2026'), rotation(6, '16/10/2026', '18/10/2026'),
  ],
};
const score = (bbs_id, rotation_id, value, guild_id = 'gA') => ({
  bbs_id, bbs_name: bbs_id.toUpperCase(), cycle_id: 'c1', rotation_id, guild_id, score: value,
});

describe('computeMonthlyWinners', () => {
  const scores = [
    score('p1', 'r1', 600), score('p1', 'r2', 610),
    score('p2', 'r1', 620, 'gB'), score('p2', 'r2', 600, 'gB'),
    score('p3', 'r1', 500, 'gB'),
    score('p1', 'r3', 615), score('p2', 'r3', 615, 'gB'), score('p3', 'r3', 400, 'gB'),
  ];

  it('only lists finished months, most recent first', () => {
    const during = computeMonthlyWinners({ cycles: [cycle], scores, now: new Date(2026, 9, 14).getTime() });
    expect(during.map((m) => m.key)).toEqual(['2026-09']);
    const after = computeMonthlyWinners({ cycles: [cycle], scores, now: new Date(2026, 10, 1).getTime() });
    expect(after.map((m) => m.key)).toEqual(['2026-10', '2026-09']);
  });

  it('ranks the top players by average, sharing the rank on a tie, and picks the best guild', () => {
    const [october, september] = computeMonthlyWinners({ cycles: [cycle], scores, now: new Date(2026, 10, 1).getTime() });
    expect(september.players.map((p) => [p.bbs_id, p.rank, p.averageScore])).toEqual([['p2', 1, 610], ['p1', 2, 605], ['p3', 3, 500]]);
    expect(september.guild).toMatchObject({ guild_id: 'gA', averageScore: 605 });
    expect(october.players.filter((p) => p.rank === 1).map((p) => p.bbs_id).sort()).toEqual(['p1', 'p2']);
  });

  it('scales the admin threshold to the rotations of the month', () => {
    // 4 per cycle of 6 rotations: September has 2 rotations, so 2 scores are required
    const [october, september] = computeMonthlyWinners({ cycles: [cycle], scores, minScoresPerCycle: 4, now: new Date(2026, 10, 1).getTime() });
    expect(september.players.map((p) => p.bbs_id)).toEqual(['p2', 'p1']);
    // October needs 3 scores: nobody qualifies, but the guild of the month remains
    expect(october.players).toEqual([]);
    expect(october.guild).not.toBeNull();
  });

  it('ignores inactive guilds for the guild of the month', () => {
    const [, september] = computeMonthlyWinners({
      cycles: [cycle], scores, activeGuildIds: new Set(['gB']), now: new Date(2026, 10, 1).getTime(),
    });
    expect(september.guild.guild_id).toBe('gB');
  });
});
