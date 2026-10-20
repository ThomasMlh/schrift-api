// Indexes matching the queries of the API. createIndex is idempotent: running it again on an
// existing index is a no-op, so the admin "create indexes" tool can be run at any time.
export const INDEXES = [
  { collection: 'scores', key: { cycle_id: 1, rotation_id: 1, bbs_id: 1 } },
  { collection: 'scores', key: { bbs_id: 1, cycle_id: 1 } },
  { collection: 'scores', key: { guild_id: 1, cycle_id: 1 } },
  { collection: 'scores', key: { rotation_id: 1 } },

  { collection: 'users', key: { discord_id: 1 } },
  { collection: 'users', key: { 'bbs_accounts.bbs_id': 1 } },
  { collection: 'users', key: { 'bbs_accounts.guilde_id': 1 } },

  // Unique: two concurrent first saves on an empty album must not create two documents
  { collection: 'albums', key: { bbs_id: 1 }, options: { unique: true } },

  { collection: 'builds', key: { rotation_id: 1, isValid: 1, created_at: -1 } },
  { collection: 'builds', key: { 'team.id_character': 1 } },

  { collection: 'activity_log', key: { created_at: -1 } },
  { collection: 'activity_log', key: { guilde_id: 1, created_at: -1 } },

  { collection: 'score_history', key: { created_at: -1 } },
  { collection: 'score_history', key: { score_id: 1 } },
  { collection: 'score_history', key: { bbs_id: 1, created_at: -1 } },

  { collection: 'guild_goals', key: { guild_id: 1, cycle_id: 1 } },

  { collection: 'applications', key: { status: 1, created_at: -1 } },

  { collection: 'characters', key: { search_name: 'text', name: 'text' } },
  { collection: 'characters', key: { search_name: 1 } },
  { collection: 'characters', key: { affinity: 1, search_name: 1 } },
  { collection: 'characters', key: { categories: 1 } },
  { collection: 'characters', key: { killers: 1 } },
  { collection: 'characters', key: { release_date: 1 } },
  { collection: 'characters', key: { rarity: 1 } },
  { collection: 'characters', key: { status: 1 } },
];

// Creates every index; one failure (e.g. duplicates blocking a unique index) does not stop the others.
export const ensureIndexes = async (db) => {
  const results = await Promise.allSettled(
    INDEXES.map(({ collection, key, options }) => db.collection(collection).createIndex(key, options))
  );
  const failed = results
    .map((result, i) => (result.status === 'rejected'
      ? { collection: INDEXES[i].collection, key: INDEXES[i].key, error: result.reason?.message }
      : null))
    .filter(Boolean);
  return { total: INDEXES.length, created: INDEXES.length - failed.length, failed };
};
