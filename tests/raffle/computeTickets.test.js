import { computeRaffleTickets, homogeneityTickets, pickWinner } from '../../src/services/raffle/computeTickets.js';

const YEAR = 365.25 * 24 * 60 * 60 * 1000;
const MONTH_END = Date.UTC(2026, 9, 4);
const rotations = [1, 2, 3, 4].map((i) => ({ cycle_id: 'c', rotation_id: `r${i}` }));

// One score per rotation for each player; `base` is the player's level, `dips` lowers given rotations
const scoresFor = (players) => players.flatMap(({ id, base, dips = {}, skip = [] }) => rotations
  .filter((r) => !skip.includes(r.rotation_id))
  .map((r) => ({ bbs_id: id, bbs_name: id, cycle_id: 'c', rotation_id: r.rotation_id, score: base - (dips[r.rotation_id] ?? 0) })));

const byId = (result) => new Map(result.players.map((p) => [p.bbs_id, p]));

describe('homogeneityTickets', () => {
  it('follows the thresholds of the rules', () => {
    expect(homogeneityTickets(-50_000)).toBe(2);
    expect(homogeneityTickets(99_999)).toBe(2);
    expect(homogeneityTickets(100_000)).toBe(1);
    expect(homogeneityTickets(300_000)).toBe(1);
    expect(homogeneityTickets(300_001)).toBe(0);
    expect(homogeneityTickets(null)).toBe(0);
  });
});

describe('computeRaffleTickets', () => {
  const sevenPlayers = [
    { id: 'p1', base: 620_000_000 },
    { id: 'p2', base: 619_900_000 },
    { id: 'p3', base: 619_800_000 },
    { id: 'p4', base: 619_700_000 },
    { id: 'p5', base: 619_600_000 },
    { id: 'p6', base: 619_500_000 },
    { id: 'p7', base: 618_000_000 },
  ];

  it('gives one ticket per rotation top 5, capped at 4, and one for the monthly top 5', () => {
    const result = byId(computeRaffleTickets({ rotations, scores: scoresFor(sevenPlayers), monthEnd: MONTH_END }));
    expect(result.get('p1').breakdown).toMatchObject({ top5_rotations: 4, top5_month: 1 });
    expect(result.get('p6').breakdown).toMatchObject({ top5_rotations: 0, top5_month: 0 });
  });

  it('shares the rank on equal scores', () => {
    const tied = [...sevenPlayers.slice(0, 4), { id: 'tieA', base: 619_600_000 }, { id: 'tieB', base: 619_600_000 }];
    const result = byId(computeRaffleTickets({ rotations, scores: scoresFor(tied), monthEnd: MONTH_END }));
    expect(result.get('tieA').breakdown.top5_rotations).toBe(4);
    expect(result.get('tieB').breakdown.top5_rotations).toBe(4);
  });

  it('measures homogeneity on the worst rotation against the guild median', () => {
    const result = byId(computeRaffleTickets({ rotations, scores: scoresFor(sevenPlayers), monthEnd: MONTH_END }));
    // Guild median is 619.7M on every rotation
    expect(result.get('p5').worst_gap).toBe(100_000);
    expect(result.get('p1').breakdown.homogeneity).toBe(2);
    expect(result.get('p5').breakdown.homogeneity).toBe(1);
    expect(result.get('p6').breakdown.homogeneity).toBe(1);
    expect(result.get('p7').breakdown.homogeneity).toBe(0);
  });

  it('is not pulled down by a player who scored 0', () => {
    const players = [...sevenPlayers.slice(0, 6), { id: 'absent', base: 619_000_000, dips: { r2: 619_000_000 } }];
    const result = byId(computeRaffleTickets({ rotations, scores: scoresFor(players), monthEnd: MONTH_END }));
    // An average would drop to about 531M on r2 and hide the 200k gap of p6
    expect(result.get('p6').worst_gap).toBe(200_000);
    expect(result.get('p6').breakdown.homogeneity).toBe(1);
    expect(result.get('absent').breakdown.homogeneity).toBe(0);
  });

  it('treats a missed rotation as the worst one', () => {
    const players = [...sevenPlayers.slice(0, 6), { id: 'late', base: 620_500_000, skip: ['r1'] }];
    const result = byId(computeRaffleTickets({ rotations, scores: scoresFor(players), monthEnd: MONTH_END }));
    expect(result.get('late').breakdown.homogeneity).toBe(0);
    expect(result.get('late').worst_gap).toBeNull();
  });

  it('only counts seniority, capped at 3 years, for players with a top 5 ticket', () => {
    const firstSeen = new Map([['p1', MONTH_END - 5.2 * YEAR], ['p2', MONTH_END - 1.5 * YEAR], ['p7', MONTH_END - 4 * YEAR]]);
    const result = byId(computeRaffleTickets({ rotations, scores: scoresFor(sevenPlayers), firstSeen, monthEnd: MONTH_END }));
    expect(result.get('p1').breakdown.seniority).toBe(3);
    expect(result.get('p2').breakdown.seniority).toBe(1);
    expect(result.get('p7').breakdown.seniority).toBe(0);
  });

  it('gives the collective tickets to every member', () => {
    const tight = sevenPlayers.slice(0, 6);
    const result = computeRaffleTickets({ rotations, scores: scoresFor(tight), rankTickets: 3, monthEnd: MONTH_END });
    expect(result.collective_gap).toBe(500_000);
    expect(result.players.every((p) => p.breakdown.rank === 3 && p.breakdown.collective_gap === 0)).toBe(true);

    const tighter = computeRaffleTickets({ rotations, scores: scoresFor(tight.slice(0, 5)), monthEnd: MONTH_END });
    expect(tighter.players.every((p) => p.breakdown.collective_gap === 1)).toBe(true);
  });

  it('adds the tickets entered by leaders and caps the total', () => {
    const manual = [
      { bbs_id: 'p7', kind: 'farm', period: 1 },
      { bbs_id: 'p7', kind: 'farm', period: 2 },
      { bbs_id: 'p7', kind: 'qg', period: 1 },
      { bbs_id: 'p7', kind: 'bonus', count: 3, label: 'Quiz' },
      { bbs_id: 'p1', kind: 'bonus', count: 20, label: 'Event' },
    ];
    const result = byId(computeRaffleTickets({ rotations, scores: scoresFor(sevenPlayers), manual, monthEnd: MONTH_END, maxTickets: 20 }));
    expect(result.get('p7').breakdown).toMatchObject({ farm: 2, qg: 1, bonus: 3 });
    expect(result.get('p7').tickets).toBe(6);
    expect(result.get('p1').earned).toBeGreaterThan(20);
    expect(result.get('p1').tickets).toBe(20);
  });

  it('lists current members without scores so leaders can give them tickets', () => {
    const result = byId(computeRaffleTickets({ rotations, scores: [], players: [{ bbs_id: 'new', bbs_name: 'Nouveau' }], monthEnd: MONTH_END }));
    expect(result.get('new')).toMatchObject({ bbs_name: 'Nouveau', tickets: 0 });
  });
});

describe('pickWinner', () => {
  const players = [{ bbs_id: 'a', tickets: 2 }, { bbs_id: 'b', tickets: 0 }, { bbs_id: 'c', tickets: 3 }];

  it('maps every ticket number to its owner', () => {
    expect([0, 1, 2, 3, 4].map((n) => pickWinner(players, n).bbs_id)).toEqual(['a', 'a', 'c', 'c', 'c']);
    expect(pickWinner(players, 5)).toBeNull();
  });
});
