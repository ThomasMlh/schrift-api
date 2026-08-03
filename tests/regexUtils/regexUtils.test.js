import { escapeRegex } from '../../src/utils/regexUtils.js';

describe('escapeRegex', () => {
  it('escapes bracket-decorated pseudos like "[FR]Whitep"', () => {
    const pattern = new RegExp(escapeRegex('[FR]Whitep'), 'i');
    expect(pattern.test('[FR]Whitep')).toBe(true);
    expect(pattern.test('FWhitep')).toBe(false);
  });

  it('escapes parenthesis-decorated pseudos like "(Nun)"', () => {
    const pattern = new RegExp(escapeRegex('伝説 蘆名氏 (Nun)'), 'i');
    expect(pattern.test('伝説 蘆名氏 (Nun)')).toBe(true);
  });

  it('leaves plain alphanumeric strings unchanged in behavior', () => {
    const pattern = new RegExp(escapeRegex('Krutheo'), 'i');
    expect(pattern.test('Krutheo')).toBe(true);
  });

  it('escapes every regex metacharacter', () => {
    const raw = '.*+?^${}()|[]\\';
    const pattern = new RegExp(`^${escapeRegex(raw)}$`);
    expect(pattern.test(raw)).toBe(true);
  });
});
