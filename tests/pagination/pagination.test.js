import { parsePaginationParams, buildPaginationMeta } from '../../src/utils/pagination.js';

describe('parsePaginationParams', () => {
  it('returns default values when query is empty', () => {
    const result = parsePaginationParams({});
    expect(result).toEqual({ page: 1, limit: 50, skip: 0 });
  });

  it('parses page and limit from the query', () => {
    const result = parsePaginationParams({ page: '3', limit: '10' });
    expect(result).toEqual({ page: 3, limit: 10, skip: 20 });
  });

  it('forces page to 1 when value is less than 1', () => {
    expect(parsePaginationParams({ page: '0' }).page).toBe(1);
    expect(parsePaginationParams({ page: '-5' }).page).toBe(1);
  });

  it('enforces the maxLimit cap', () => {
    const result = parsePaginationParams({ limit: '999' });
    expect(result.limit).toBe(200);
  });

  it('accepts custom defaultLimit and maxLimit', () => {
    const result = parsePaginationParams({}, 20, 100);
    expect(result.limit).toBe(20);
  });

  it('computes the correct skip value', () => {
    expect(parsePaginationParams({ page: '5', limit: '10' }).skip).toBe(40);
  });
});

describe('buildPaginationMeta', () => {
  it('returns correct metadata for a middle page', () => {
    const meta = buildPaginationMeta(2, 10, 50, 10);
    expect(meta).toEqual({
      currentPage: 2,
      totalPages: 5,
      totalCount: 50,
      hasNextPage: true,
      hasPrevPage: true,
      itemsPerPage: 10,
      itemsOnPage: 10,
    });
  });

  it('sets hasNextPage to false on the last page', () => {
    const meta = buildPaginationMeta(5, 10, 50, 5);
    expect(meta.hasNextPage).toBe(false);
    expect(meta.hasPrevPage).toBe(true);
  });

  it('sets hasPrevPage to false on the first page', () => {
    const meta = buildPaginationMeta(1, 10, 50, 10);
    expect(meta.hasPrevPage).toBe(false);
    expect(meta.hasNextPage).toBe(true);
  });

  it('handles a single-page result set', () => {
    const meta = buildPaginationMeta(1, 50, 5, 5);
    expect(meta.totalPages).toBe(1);
    expect(meta.hasNextPage).toBe(false);
    expect(meta.hasPrevPage).toBe(false);
  });
});
