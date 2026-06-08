export const parsePaginationParams = (query, defaultLimit = 50, maxLimit = 200) => {
  const page = Math.max(1, parseInt(query.page) || 1);
  const limit = Math.min(parseInt(query.limit) || defaultLimit, maxLimit);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
};

export const buildPaginationMeta = (page, limit, totalCount, itemsOnPage) => {
  const totalPages = Math.ceil(totalCount / limit);
  return {
    currentPage: page,
    totalPages,
    totalCount,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
    itemsPerPage: limit,
    itemsOnPage,
  };
};
