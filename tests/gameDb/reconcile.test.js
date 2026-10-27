import { reconcileCharacters } from '../../src/services/gameDb/reconcile.js';
import { changedFields, gameUpdate, newCharacter } from '../../src/services/gameDb/characterDocuments.js';

const stats = (end) => ({ end, atk: 600, def: 300, cct: 300, pre: 800 });
const game = (gameId, visual, extra = {}) => ({
  game_id: gameId, resource_2d_id: visual, name: 'Ichibe Hyosube', affinity: 'Force', stats: stats(1000), release_date: '01/01/2025', ...extra,
});
const site = (id, visual, extra = {}) => ({
  _id: id, name: 'Ichibe Hyosube', affinity: 'Force', stats: stats(1000), release_date: '01/01/2025',
  source_images: visual ? { thumbnail: `https://bucket.bbs-simulator.com/character/${visual}-abc.png` } : {}, created_at: '2026-01-01', ...extra,
});

describe('reconcileCharacters', () => {
  it('links by thumbnail visual, and by name when there is no thumbnail', () => {
    const result = reconcileCharacters(
      [site('a', '1656'), site('b', null, { name: 'Kon' })],
      [game(61650, '1656'), game(61052, '0343', { name: 'Kon' }), game(65115, '2000', { name: 'Ichigo' })]
    );
    expect(result.matches.map((m) => [m.doc._id, m.game.game_id, m.method])).toEqual([['a', 61650, 'visual'], ['b', 61052, 'name']]);
    expect(result.created.map((g) => g.game_id)).toEqual([65115]);
  });

  it('tells apart units sharing a visual by affinity, then stats', () => {
    const result = reconcileCharacters(
      [site('a', '1656', { affinity: 'Vitesse' }), site('b', '1656', { stats: stats(1200) })],
      [game(61650, '1656'), game(65110, '1656', { affinity: 'Vitesse' }), game(65111, '1656', { stats: stats(1200) })]
    );
    expect(Object.fromEntries(result.matches.map((m) => [m.doc._id, m.game.game_id]))).toEqual({ a: 65110, b: 65111 });
    expect(result.duplicates).toEqual([]);
  });

  it('keeps an existing game_id link and merges site duplicates into the oldest document', () => {
    const result = reconcileCharacters(
      [site('new', '1656', { created_at: '2026-05-01' }), site('old', null, { game_id: 61650, created_at: '2025-01-01' })],
      [game(61650, '1656')]
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].doc._id).toBe('old');
    expect(result.duplicates).toEqual([{ game_id: 61650, keep_id: 'old', merge_ids: ['new'] }]);
  });

  it('reports what it cannot link', () => {
    const result = reconcileCharacters([site('lost', '9999'), site('twin', '1656')], [game(1, '1656'), game(2, '1656')]);
    expect(result.unmatched.map((d) => d._id)).toEqual(['lost']);
    expect(result.ambiguous).toEqual([{ doc: expect.objectContaining({ _id: 'twin' }), candidates: [1, 2] }]);
  });
});

describe('character documents', () => {
  const now = new Date('2026-10-28T00:00:00Z');
  const built = { ...game(61758, '1872'), attack_type: null, release_date: null, resurrection: { release_date: '28/10/2026' }, traits: { passive: [] } };

  it('fills dates only when the site has none, and takes the attack color from the game', () => {
    const update = gameUpdate({ ...built, attack_type: 'R', release_date: '30/08/2025' }, { attack_type: 'B', release_date: null, resurrection_release: null }, now);
    expect(update).toMatchObject({ attack_type: 'R', release_date: '30/08/2025', resurrection_release: '28/10/2026' });
  });

  it('keeps the site value when the game has none, and never touches hand-entered fields', () => {
    const update = gameUpdate(built, { attack_type: 'B', release_date: '31/08/2025', version_name: 'Maillots', banner_id: 'x' }, now);
    expect(update).toMatchObject({ game_id: 61758, attack_type: 'B', release_date: '31/08/2025', resurrection_release: '28/10/2026', game_synced_at: now });
    expect(update).not.toHaveProperty('version_name');
    expect(update).not.toHaveProperty('banner_id');
  });

  it('creates a new character waiting for its images', () => {
    expect(newCharacter({ ...built, game_version: { fr: 'version Noël' } }, now)).toMatchObject({
      game_id: 61758, search_name: 'Ichibe Hyosube version Noël', version: 'Force Noël Ichibe Hyosube', images_pending: ['thumbnail', 'artwork'], created_at: now,
      source_images: { thumbnail: 'https://bucket.bbs-schrift.fr/rmfs/Characters/1872/thumb.png', artwork: 'https://bucket.bbs-schrift.fr/rmfs/Characters/1872/stand_gacha.png' },
    });
  });

  it('lists the changed fields for the preview', () => {
    const update = gameUpdate(built, {}, now);
    expect(changedFields(update, { ...update, affinity: 'Vitesse', game_synced_at: new Date(0) })).toEqual(['affinity']);
  });
});
