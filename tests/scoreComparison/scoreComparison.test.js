import { getScopeDescription } from '../../src/services/scoreComparison.js';

describe('getScopeDescription', () => {
  it('returns the description for a specific rotation within a cycle', () => {
    expect(getScopeDescription('cycle1', 'rotation1')).toBe("Rotation spécifique d'un cycle");
  });

  it('returns the description for a full cycle', () => {
    expect(getScopeDescription('cycle1', null)).toBe('Cycle complet');
  });

  it('returns the description for a rotation across all cycles', () => {
    expect(getScopeDescription(null, 'rotation1')).toBe('Rotation spécifique (tous cycles)');
  });

  it('returns the global description when no filter is applied', () => {
    expect(getScopeDescription(null, null)).toBe('Tous les scores');
  });
});
