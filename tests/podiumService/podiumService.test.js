import {
  applyRanks,
  paginate,
  overrideGuildName,
  buildGuildMatch,
  getMinScoresForRanking,
  getCurrentGuildBbsIds,
  getUnguildedBbsIds,
} from '../../src/services/podiumService.js';

describe('applyRanks', () => {
  it('assigns increasing ranks when every score is distinct', () => {
    const results = [{ score: 100 }, { score: 90 }, { score: 80 }];
    expect(applyRanks(results, 'score')).toEqual([
      { rank: 1, score: 100 },
      { rank: 2, score: 90 },
      { rank: 3, score: 80 },
    ]);
  });

  it('gives tied scores the same rank, using dense ranking (no gap after a tie)', () => {
    // Deux joueurs à 100 sont tous les deux 1er ; le suivant est 2e, pas 3e.
    const results = [{ score: 100 }, { score: 100 }, { score: 90 }, { score: 80 }];
    expect(applyRanks(results, 'score')).toEqual([
      { rank: 1, score: 100 },
      { rank: 1, score: 100 },
      { rank: 2, score: 90 },
      { rank: 3, score: 80 },
    ]);
  });

  it('handles a run of more than two tied scores', () => {
    const results = [{ score: 50 }, { score: 50 }, { score: 50 }, { score: 10 }];
    expect(applyRanks(results, 'score').map(r => r.rank)).toEqual([1, 1, 1, 2]);
  });

  it('returns an empty array unchanged', () => {
    expect(applyRanks([], 'score')).toEqual([]);
  });

  it('ranks using an arbitrary score key', () => {
    const results = [{ week_total_score: 5 }, { week_total_score: 5 }, { week_total_score: 1 }];
    expect(applyRanks(results, 'week_total_score').map(r => r.rank)).toEqual([1, 1, 2]);
  });
});

describe('paginate', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));

  it('slices the first page and reports pagination metadata', () => {
    const { items: page, pagination } = paginate(items, 1, 10);
    expect(page).toHaveLength(10);
    expect(page[0]).toEqual({ id: 1 });
    expect(pagination).toEqual({
      currentPage: 1,
      totalPages: 3,
      totalCount: 25,
      hasNextPage: true,
      hasPrevPage: false,
      itemsPerPage: 10,
      itemsOnPage: 10,
    });
  });

  it('reports a partial last page correctly', () => {
    const { items: page, pagination } = paginate(items, 3, 10);
    expect(page).toHaveLength(5);
    expect(pagination.hasNextPage).toBe(false);
    expect(pagination.hasPrevPage).toBe(true);
    expect(pagination.itemsOnPage).toBe(5);
  });

  it('returns an empty page and totalPages 0 for an empty input', () => {
    const { items: page, pagination } = paginate([], 1, 10);
    expect(page).toEqual([]);
    expect(pagination.totalPages).toBe(0);
    expect(pagination.hasNextPage).toBe(false);
    expect(pagination.hasPrevPage).toBe(false);
  });

  it('returns an empty page when requesting a page past the end', () => {
    const { items: page } = paginate(items, 10, 10);
    expect(page).toEqual([]);
  });
});

describe('overrideGuildName', () => {
  it('overwrites guild_name on every result when a guildName is given', () => {
    const results = [{ guild_name: 'old-A' }, { guild_name: 'old-B' }];
    overrideGuildName(results, 'Current Guild');
    expect(results).toEqual([{ guild_name: 'Current Guild' }, { guild_name: 'Current Guild' }]);
  });

  it('leaves results untouched when guildName is falsy', () => {
    const results = [{ guild_name: 'old-A' }];
    overrideGuildName(results, null);
    expect(results).toEqual([{ guild_name: 'old-A' }]);
  });

  it('returns the same array reference it mutated', () => {
    const results = [{ guild_name: 'old-A' }];
    expect(overrideGuildName(results, 'X')).toBe(results);
  });
});

describe('buildGuildMatch', () => {
  it('wraps the given bbs_id list in a Mongo $in filter', () => {
    expect(buildGuildMatch(['bbs-1', 'bbs-2'])).toEqual({ bbs_id: { $in: ['bbs-1', 'bbs-2'] } });
  });

  it('works with an empty list (matches nothing)', () => {
    expect(buildGuildMatch([])).toEqual({ bbs_id: { $in: [] } });
  });
});

describe('getMinScoresForRanking', () => {
  const makeDb = (settingsDoc) => ({
    collection: () => ({ findOne: async () => settingsDoc }),
  });

  it('returns the configured threshold when one is set', async () => {
    const db = makeDb({ _id: 'podium', min_scores_for_ranking: 10 });
    expect(await getMinScoresForRanking(db)).toBe(10);
  });

  it('falls back to 0 (disabled) when no settings document exists', async () => {
    const db = makeDb(null);
    expect(await getMinScoresForRanking(db)).toBe(0);
  });

  it('falls back to 0 when the stored value is not a number', async () => {
    const db = makeDb({ _id: 'podium', min_scores_for_ranking: '10' });
    expect(await getMinScoresForRanking(db)).toBe(0);
  });

  it('treats an explicit 0 as a valid configured value (threshold disabled on purpose)', async () => {
    const db = makeDb({ _id: 'podium', min_scores_for_ranking: 0 });
    expect(await getMinScoresForRanking(db)).toBe(0);
  });
});

describe('getCurrentGuildBbsIds', () => {
  const makeDb = (users) => ({
    collection: () => ({ find: () => ({ toArray: async () => users }) }),
  });

  it('collects bbs_id for accounts currently in the given guild', async () => {
    const db = makeDb([
      { bbs_accounts: [{ bbs_id: 'bbs-1', guilde_id: 'guild-A' }, { bbs_id: 'bbs-2', guilde_id: 'guild-B' }] },
      { bbs_accounts: [{ bbs_id: 'bbs-3', guilde_id: 'guild-A' }] },
    ]);
    const result = await getCurrentGuildBbsIds(db, 'guild-A');
    expect(result.sort()).toEqual(['bbs-1', 'bbs-3']);
  });

  it('ignores accounts with a matching guild but no bbs_id', async () => {
    const db = makeDb([{ bbs_accounts: [{ guilde_id: 'guild-A' }] }]);
    expect(await getCurrentGuildBbsIds(db, 'guild-A')).toEqual([]);
  });

  it('returns an empty array when the user has no bbs_accounts', async () => {
    const db = makeDb([{ bbs_accounts: undefined }]);
    expect(await getCurrentGuildBbsIds(db, 'guild-A')).toEqual([]);
  });

  it('a bbs account can be counted for multiple users if data is inconsistent, but never for the wrong guild', async () => {
    const db = makeDb([
      { bbs_accounts: [{ bbs_id: 'bbs-1', guilde_id: 'guild-A' }] },
      { bbs_accounts: [{ bbs_id: 'bbs-2', guilde_id: 'guild-B' }] },
    ]);
    expect(await getCurrentGuildBbsIds(db, 'guild-B')).toEqual(['bbs-2']);
  });
});

describe('getUnguildedBbsIds', () => {
  const makeDb = (users) => ({
    collection: () => ({ find: () => ({ toArray: async () => users }) }),
  });

  it('collects bbs_id for accounts with no guild', async () => {
    const db = makeDb([
      { bbs_accounts: [{ bbs_id: 'bbs-1', guilde_id: null }, { bbs_id: 'bbs-2', guilde_id: 'guild-A' }] },
    ]);
    expect(await getUnguildedBbsIds(db)).toEqual(['bbs-1']);
  });

  it('ignores unguilded accounts with no bbs_id', async () => {
    const db = makeDb([{ bbs_accounts: [{ guilde_id: null }] }]);
    expect(await getUnguildedBbsIds(db)).toEqual([]);
  });
});
