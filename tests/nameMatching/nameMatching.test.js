import {
  normalizeName,
  calculateSimilarity,
  findBestMatch,
  cleanPlayerNameOCR,
  parseScore,
  getUserDisplayName,
} from '../../src/utils/nameMatching.js';

describe('getUserDisplayName', () => {
  it('returns bbs_name with highest priority', () => {
    expect(getUserDisplayName({ bbs_name: 'Storm', global_name: 'X', username: 'Y' })).toBe('Storm');
  });

  it('returns global_name when bbs_name is absent', () => {
    expect(getUserDisplayName({ global_name: 'X', username: 'Y' })).toBe('X');
  });

  it('returns username as last fallback', () => {
    expect(getUserDisplayName({ username: 'Y' })).toBe('Y');
  });

  it('returns the fallback value when user is null', () => {
    expect(getUserDisplayName(null)).toBe('Inconnu');
    expect(getUserDisplayName(null, 'Anonymous')).toBe('Anonymous');
  });
});

describe('normalizeName', () => {
  it('returns an empty string for null or undefined input', () => {
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
    expect(normalizeName('')).toBe('');
  });

  it('converts to lowercase', () => {
    expect(normalizeName('STORM')).toBe('storm');
  });

  it('removes accented characters', () => {
    expect(normalizeName('éàôîùç')).toBe('eaoiuc');
  });

  it('removes spaces, dashes, underscores and special characters', () => {
    expect(normalizeName('Storm Isi')).toBe('stormisi');
    expect(normalizeName('Storm-Isi')).toBe('stormisi');
    expect(normalizeName('Storm_Isi')).toBe('stormisi');
    expect(normalizeName('Storm†Isi')).toBe('stormisi');
  });
});

describe('calculateSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    expect(calculateSimilarity('storm', 'storm')).toBe(1);
  });

  it('returns 0 when either string is empty or null', () => {
    expect(calculateSimilarity('', 'storm')).toBe(0);
    expect(calculateSimilarity(null, 'storm')).toBe(0);
  });

  it('returns a value between 0 and 1 for similar strings', () => {
    const sim = calculateSimilarity('storm', 'strom');
    expect(sim).toBeGreaterThan(0.5);
    expect(sim).toBeLessThan(1);
  });

  it('returns a low value for very different strings', () => {
    expect(calculateSimilarity('aaa', 'zzzzzzzzz')).toBeLessThan(0.5);
  });
});

describe('findBestMatch', () => {
  const members = [
    { bbs_name: 'Storm' },
    { bbs_name: 'Raven' },
    { bbs_name: 'Fenix' },
  ];

  it('returns null when detectedName is empty', () => {
    const result = findBestMatch('', members);
    expect(result.user).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it('returns null when the members list is empty', () => {
    const result = findBestMatch('Storm', []);
    expect(result.user).toBeNull();
  });

  it('returns an exact match with confidence 1.0', () => {
    const result = findBestMatch('Storm', members);
    expect(result.user.bbs_name).toBe('Storm');
    expect(result.confidence).toBe(1.0);
  });

  it('returns a normalized match with confidence 0.95', () => {
    // "Stôrm" normalizes to "storm", identical to normalized "Storm"
    const result = findBestMatch('Stôrm', members);
    expect(result.confidence).toBe(0.95);
  });

  it('returns null when no match exceeds 70% confidence', () => {
    const result = findBestMatch('XXXXXXXX', members);
    expect(result.user).toBeNull();
  });
});

describe('cleanPlayerNameOCR', () => {
  it('returns an empty string for null input', () => {
    expect(cleanPlayerNameOCR(null)).toBe('');
  });

  it('removes "Gradus" and "Grade" suffixes', () => {
    expect(cleanPlayerNameOCR('Storm Gradus 1191')).toBe('Storm');
    expect(cleanPlayerNameOCR('Storm Grade A')).toBe('Storm');
  });

  it('removes vertical bar artifacts', () => {
    expect(cleanPlayerNameOCR('St|orm')).toBe('Storm');
  });

  it('collapses multiple spaces into one', () => {
    expect(cleanPlayerNameOCR('St  orm')).toBe('St orm');
  });
});

describe('parseScore', () => {
  it('parses a valid score with comma separators', () => {
    expect(parseScore('588,187,015')).toEqual({ value: 588187015, error: null });
  });

  it('parses a valid score without separators', () => {
    expect(parseScore('588187015')).toEqual({ value: 588187015, error: null });
  });

  it('returns an error for empty or null input', () => {
    expect(parseScore('')).toMatchObject({ value: null });
    expect(parseScore(null)).toMatchObject({ value: null });
  });

  it('returns an error when there are too few digits', () => {
    expect(parseScore('123')).toMatchObject({ value: null });
  });

  it('returns an error when there are too many digits', () => {
    expect(parseScore('123456789012')).toMatchObject({ value: null });
  });

  it('returns an error when the value is out of bounds', () => {
    expect(parseScore('12345')).toMatchObject({ value: null });
  });
});
