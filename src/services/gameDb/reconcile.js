/**
 * Links the site characters to the game characters built from the master tables.
 * A character already linked keeps its game_id. Otherwise the id in its thumbnail URL is the game
 * resource_2d_id; several units can share a visual, so affinity, stats and release date break ties.
 */
const THUMB_ID = /\/character\/(\d+)-/;
const STAT_KEYS = ['end', 'atk', 'def', 'cct', 'pre'];

const thumbnailId = (doc) => THUMB_ID.exec(doc.source_images?.thumbnail ?? '')?.[1] ?? null;
const sameStats = (a, b) => Boolean(a && b) && STAT_KEYS.every((key) => Number(a[key]) === Number(b[key]));
const normalize = (text) => (text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Narrows the candidates with each criterion in turn, as long as one keeps at least one candidate
const narrow = (candidates, doc) => {
  let left = candidates;
  for (const keep of [
    (g) => g.affinity === doc.affinity,
    (g) => sameStats(g.stats, doc.stats),
    (g) => g.release_date === doc.release_date,
    (g) => normalize(g.name) === normalize(doc.name),
  ]) {
    if (left.length <= 1) break;
    const kept = left.filter(keep);
    if (kept.length > 0) left = kept;
  }
  return left;
};

const createdAt = (doc) => new Date(doc.created_at ?? 0).getTime();

export const reconcileCharacters = (siteCharacters, gameCharacters) => {
  const byGameId = new Map(gameCharacters.map((g) => [g.game_id, g]));
  const byVisual = new Map();
  for (const g of gameCharacters) {
    if (!byVisual.has(g.resource_2d_id)) byVisual.set(g.resource_2d_id, []);
    byVisual.get(g.resource_2d_id).push(g);
  }

  const linked = new Map();
  const unmatched = [];
  const ambiguous = [];
  const link = (game, doc, method) => {
    if (!linked.has(game.game_id)) linked.set(game.game_id, []);
    linked.get(game.game_id).push({ doc, method });
  };

  // Already linked characters first, so the others cannot take their game unit
  const pending = [];
  for (const doc of siteCharacters) {
    const game = doc.game_id ? byGameId.get(doc.game_id) : null;
    if (game) link(game, doc, 'game_id');
    else pending.push(doc);
  }

  for (const doc of pending) {
    const visualId = thumbnailId(doc);
    const free = (g) => !linked.has(g.game_id);
    let candidates = visualId ? (byVisual.get(visualId) ?? []) : gameCharacters.filter((g) => normalize(g.name) === normalize(doc.name));
    // Prefer a game unit nobody took yet; a taken one means a duplicate on the site
    if (candidates.some(free)) candidates = candidates.filter(free);
    const left = narrow(candidates, doc);
    if (left.length === 1) link(left[0], doc, visualId ? 'visual' : 'name');
    else if (left.length === 0) unmatched.push(doc);
    else ambiguous.push({ doc, candidates: left.map((g) => g.game_id) });
  }

  const matches = [];
  const duplicates = [];
  for (const [gameId, entries] of linked) {
    // The oldest document stays: albums and builds of the others move to it
    const [keep, ...merged] = [...entries].sort((a, b) => createdAt(a.doc) - createdAt(b.doc));
    matches.push({ game: byGameId.get(gameId), doc: keep.doc, method: keep.method });
    if (merged.length > 0) duplicates.push({ game_id: gameId, keep_id: keep.doc._id, merge_ids: merged.map((e) => e.doc._id) });
  }

  return {
    matches,
    duplicates,
    unmatched,
    ambiguous,
    created: gameCharacters.filter((g) => !linked.has(g.game_id)),
  };
};
