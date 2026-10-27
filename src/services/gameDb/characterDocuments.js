/**
 * What a game sync writes in the `characters` collection. Fields the game provides are replaced;
 * fields entered by hand on the site (version_name, banner, NAD/SAD, immunities, images...) are kept.
 */
import { toSearchName } from '../characterSource.js';
import { rmfsImages } from './source.js';

// Fields always taken from the game
const GAME_FIELDS = [
  'game_id', 'resource_2d_id', 'identity', 'name', 'names', 'short_names', 'game_version', 'affinity', 'killers',
  'categories', 'is_growth_event', 'stats', 'base_stats', 'stats_tiers', 'traits', 'special', 'profile',
  'filter_types', 'resurrection',
];

// Release dates (banner vs game data dates) and the attack color can differ from what the site entered:
// the site value wins, the game only fills a missing one
const fillField = (gameValue, siteValue) => siteValue ?? gameValue ?? null;

// $set of an existing site character, its _id (used by albums, builds and image names) never changes
export const gameUpdate = (game, doc, now = new Date()) => ({
  ...Object.fromEntries(GAME_FIELDS.map((field) => [field, game[field] ?? null])),
  attack_type: fillField(game.attack_type, doc.attack_type),
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
  source_images: rmfsImages(game.resource_2d_id),
  images_pending: ['thumbnail', 'artwork'],
  images_uploaded: false,
  created_at: now,
});

// A character whose game visual changed takes the new rmfs images; the first link keeps the current ones
export const imageUpdate = (game, doc) => {
  if (!doc.resource_2d_id || doc.resource_2d_id === game.resource_2d_id) return null;
  const images = rmfsImages(game.resource_2d_id);
  return {
    set: { 'source_images.thumbnail': images.thumbnail, 'source_images.artwork': images.artwork, 'source_images.silhouette': null, images_uploaded: false },
    pending: ['thumbnail', 'artwork'],
  };
};

// Fields that changed, for the sync preview
export const changedFields = (update, doc) => Object.keys(update)
  .filter((field) => !['game_synced_at', 'updated_at'].includes(field))
  .filter((field) => JSON.stringify(update[field] ?? null) !== JSON.stringify(doc[field] ?? null));
