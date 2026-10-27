/**
 * What a game sync writes in the `characters` collection. Fields the game provides are replaced;
 * fields entered by hand on the site (version_name, banner, NAD/SAD, immunities, images...) are kept.
 */
import { toSearchName } from '../characterSource.js';

// Fields always taken from the game
const GAME_FIELDS = [
  'game_id', 'resource_2d_id', 'identity', 'name', 'names', 'short_names', 'game_version', 'affinity', 'killers',
  'categories', 'is_growth_event', 'stats', 'base_stats', 'stats_tiers', 'traits', 'special', 'profile',
  'filter_types', 'resurrection',
];

// Fields the game only sometimes knows: an empty game value keeps the site value
const fillField = (gameValue, siteValue) => (gameValue === null || gameValue === undefined ? siteValue ?? null : gameValue);

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
  search_name: toSearchName([game.name, game.game_version?.fr].filter(Boolean).join(' ')),
  version_name: null,
  images_pending: true,
  created_at: now,
});

// Fields that changed, for the sync preview
export const changedFields = (update, doc) => Object.keys(update)
  .filter((field) => !['game_synced_at', 'updated_at'].includes(field))
  .filter((field) => JSON.stringify(update[field] ?? null) !== JSON.stringify(doc[field] ?? null));
