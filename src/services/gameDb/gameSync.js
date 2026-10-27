/**
 * Character sync from the game master tables. Characters are matched by game_id (or, the first time,
 * by visual), updated in place so their _id never changes, and created when the game has new ones.
 * Nothing is ever deleted: characters missing from the game are only reported.
 */
import { reorderCharactersByReleaseDate } from '../../utils/characterHelpers.js';
import { buildCharacters, GAME_TABLES } from './buildCharacters.js';
import { changedFields, gameUpdate, imageUpdate, newCharacter } from './characterDocuments.js';
import { createDictionary } from './dictionary.js';
import { reconcileCharacters } from './reconcile.js';
import { buildTraitFilters } from './traitFilters.js';
import { loadGameTables } from './source.js';

const PREVIEW_LIMIT = 50;
export const TRAIT_FILTERS_SETTING = 'game_trait_filters';

const label = (character) => ({ _id: character._id ?? null, game_id: character.game_id ?? null, name: character.name, version: character.version_name ?? character.game_version?.fr ?? null });

export const planGameSync = (siteCharacters, gameCharacters, now = new Date()) => {
  const { matches, duplicates, unmatched, ambiguous, created } = reconcileCharacters(siteCharacters, gameCharacters);
  const updates = matches.map(({ game, doc, method }) => {
    const set = gameUpdate(game, doc, now);
    return { doc, game, method, set, changes: changedFields(set, doc), images: imageUpdate(game, doc) };
  });
  return { updates, created: created.map((game) => newCharacter(game, now)), duplicates, unmatched, ambiguous };
};

const previewOf = (plan, languages) => {
  const changed = plan.updates.filter((u) => u.changes.length > 0);
  const fieldCounts = {};
  for (const u of changed) for (const field of u.changes) fieldCounts[field] = (fieldCounts[field] ?? 0) + 1;
  return {
    languages,
    statistics: {
      linked: plan.updates.length,
      firstLinks: plan.updates.filter((u) => u.method !== 'game_id').length,
      updated: changed.length,
      created: plan.created.length,
      newImages: plan.updates.filter((u) => u.images).length + plan.created.length,
      duplicates: plan.duplicates.length,
      unmatched: plan.unmatched.length,
      ambiguous: plan.ambiguous.length,
    },
    fieldCounts,
    preview: {
      created: plan.created.slice(0, PREVIEW_LIMIT).map(label),
      updated: changed.slice(0, PREVIEW_LIMIT).map((u) => ({ ...label(u.doc), changes: u.changes })),
      duplicates: plan.duplicates,
      unmatched: plan.unmatched.map(label),
      ambiguous: plan.ambiguous.map(({ doc, candidates }) => ({ ...label(doc), candidates })),
    },
  };
};

export const syncCharactersFromGame = async (db, { dryRun = true } = {}) => {
  const tables = await loadGameTables(GAME_TABLES);
  const dict = createDictionary(tables.m_dictionary);
  const gameCharacters = buildCharacters(tables, dict);
  const siteCharacters = await db.collection('characters').find({}).toArray();
  const plan = planGameSync(siteCharacters, gameCharacters);
  const preview = previewOf(plan, dict.languages);
  if (dryRun) return { dryRun: true, ...preview };

  await db.collection('app_settings').updateOne(
    { _id: TRAIT_FILTERS_SETTING },
    { $set: { categories: buildTraitFilters(tables, dict), languages: dict.languages, updated_at: new Date() } },
    { upsert: true }
  );

  const ops = [
    ...plan.updates.filter((u) => u.changes.length > 0 || u.images).map((u) => ({
      updateOne: {
        filter: { _id: u.doc._id },
        update: u.images
          ? { $set: { ...u.set, ...u.images.set }, $addToSet: { images_pending: { $each: u.images.pending } } }
          : { $set: u.set },
      },
    })),
    ...plan.created.map((doc) => ({ insertOne: { document: doc } })),
  ];
  if (ops.length > 0) await db.collection('characters').bulkWrite(ops, { ordered: false });
  if (plan.created.length > 0 || plan.updates.some((u) => u.changes.includes('release_date'))) await reorderCharactersByReleaseDate(db);
  return { dryRun: false, ...preview };
};
