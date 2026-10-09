import { computeStatMax, parseStat } from '../../src/utils/characterHelpers.js';

describe('parseStat', () => {
  it('keeps the digits of a formatted stat', () => {
    expect(parseStat('12 345')).toBe(12345);
    expect(parseStat('9,876')).toBe(9876);
  });

  it('returns 0 for a missing or empty stat', () => {
    expect(parseStat(undefined)).toBe(0);
    expect(parseStat('')).toBe(0);
  });
});

describe('computeStatMax', () => {
  it('returns the highest value of each stat across characters', () => {
    const docs = [
      { stats: { end: '10 000', atk: '5 000', def: '700', cct: '300', pre: '200' } },
      { stats: { end: '8 000', atk: '6 500', def: '900', cct: '100', pre: '450' } },
      { stats: {} },
    ];
    expect(computeStatMax(docs)).toEqual({ end: 10000, atk: 6500, def: 900, cct: 300, pre: 450 });
  });

  it('returns zeros without characters', () => {
    expect(computeStatMax([])).toEqual({ end: 0, atk: 0, def: 0, cct: 0, pre: 0 });
  });
});
