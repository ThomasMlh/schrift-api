/**
 * What a game sync writes in the `characters` collection. Fields the game provides are replaced;
 * fields entered by hand on the site (version_name, banner, NAD/SAD, immunities, images...) are kept.
 */
import { toSearchName } from '../characterSource.js';
import { rmfsImages } from './source.js';
import { GAME_IMAGE_REVISIONS, IMAGE_TARGETS, changedImageTargets } from '../characterImages.js';

// Fields always taken from the game
const GAME_FIELDS = [
  'game_id', 'resource_2d_id', 'identity', 'name', 'names', 'short_names', 'game_version', 'affinity', 'killers',
  'categories', 'is_growth_event', 'stats', 'base_stats', 'stats_tiers', 'traits', 'special', 'profile', 'quote',
  'filter_types', 'resurrection', 'banners',
];

// Release dates can differ from what the site entered (banner vs game data dates): the site value wins,
// the game only fills a missing one
const fillField = (gameValue, siteValue) => siteValue ?? gameValue ?? null;

// $set of an existing site character, its _id (used by albums, builds and image names) never changes
export const gameUpdate = (game, doc, now = new Date()) => ({
  ...Object.fromEntries(GAME_FIELDS.map((field) => [field, game[field] ?? null])),
  attack_type: game.attack_type ?? doc.attack_type ?? null,
  release_date: fillField(game.release_date, doc.release_date),
  resurrection_release: fillField(game.resurrection?.release_date, doc.resurrection_release),
  game_synced_at: now,
  updated_at: now,
});

// Document of a character the site does not have yet; its images are uploaded afterwards
export const newCharacter = (game, now = new Date()) => ({
  ...gameUpdate(game, {}, now),
  search_name: toSearchName([game.name, game.game_version?.fr].filter(Boolean).join(' ').replace(/[/,]/g, ' ')).replace(/\s+/g, ' '),
  version_name: null,
  // Same shape as the existing labels ("Force Burn The Witch Ninny Spangcole"), used by album tiles
  version: [game.affinity, (game.game_version?.fr ?? '').replace(/^version\s+/i, ''), game.name].filter(Boolean).join(' '),
  source_images: rmfsImages(game),
  images_pending: IMAGE_TARGETS.filter((target) => rmfsImages(game)[target.sources[0]]).map((target) => target.key),
  images_uploaded: false,
  images_revisions: GAME_IMAGE_REVISIONS,
  created_by_game_sync: true,
  created_at: now,
});

// Images come from the game files: the targets whose source changed are uploaded again.
// The legacy silhouette is dropped, the game artwork is complete on its own.
export const imageUpdate = (game, doc) => {
  const next = { ...(doc.source_images ?? {}), ...rmfsImages(game), silhouette: null };
  // Images prepared with an older treatment are uploaded again (revision 1 before revisions existed)
  const outdated = Object.entries(GAME_IMAGE_REVISIONS)
    .filter(([key, revision]) => next[key] && (doc.images_revisions?.[key] ?? 1) < revision)
    .map(([key]) => key);
  const pending = [...new Set([...changedImageTargets(doc.source_images, next), ...outdated])];
  if (pending.length === 0) return null;
  return {
    set: Object.fromEntries([
      ...Object.entries(next).map(([key, url]) => [`source_images.${key}`, url ?? null]),
      ['images_uploaded', false],
      ['images_revisions', GAME_IMAGE_REVISIONS],
    ]),
    pending,
  };
};

// Fields that changed, for the sync preview
export const changedFields = (update, doc) => Object.keys(update)
  .filter((field) => !['game_synced_at', 'updated_at'].includes(field))
  .filter((field) => JSON.stringify(update[field] ?? null) !== JSON.stringify(doc[field] ?? null));
