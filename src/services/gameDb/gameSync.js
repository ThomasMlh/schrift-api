/**
 * Character sync from the game master tables. Characters are matched by game_id (or, the first time,
 * by visual), updated in place so their _id never changes, and created when the game has new ones.
 * Nothing is ever deleted: characters missing from the game are only reported.
 */
import { reorderCharactersByReleaseDate } from '../../utils/characterHelpers.js';
import { buildCharacters, GAME_TABLES, OPTIONAL_GAME_TABLES } from './buildCharacters.js';
import { changedFields, gameUpdate, imageUpdate, newCharacter } from './characterDocuments.js';
import { createDictionary } from './dictionary.js';
import { reconcileCharacters } from './reconcile.js';
import { buildDestructionFilters, buildSpecialFilters, buildTraitFilters } from './traitFilters.js';
import { createRmfsIndex, indexedRmfsFolders, loadGameData } from './source.js';
import { accessoryChanges, buildAccessories, buildSubeffects, saveAccessories } from './accessories.js';
import { bonusAbilityChanges, buildBonusAbilities, saveBonusAbilities } from './bonusAbilities.js';
import { mergeDuplicates } from './mergeDuplicates.js';
import {
  buildGameBanners, countBannerImagesToQueue, GAME_BANNER_SOURCE, legacyBannersFilter, removeLegacyBanners, saveGameBanners,
} from './banners.js';
import { createSummonCatalog, createSummonDetails, SUMMON_TABLES } from './summons.js';

const PREVIEW_LIMIT = 50;
export const TRAIT_FILTERS_SETTING = 'game_trait_filters';

const label = (character) => ({ _id: character._id ?? null, game_id: character.game_id ?? null, name: character.name, version: character.version_name ?? character.game_version?.fr ?? null });

export const planGameSync = (siteCharacters, gameCharacters, now = new Date(), exists = () => true) => {
  const { matches, duplicates, unmatched, ambiguous, created } = reconcileCharacters(siteCharacters, gameCharacters);
  const updates = matches.map(({ game, doc, method }) => {
    const set = gameUpdate(game, doc, now);
    return { doc, game, method, set, changes: changedFields(set, doc), images: imageUpdate(game, doc, exists) };
  });
  return { updates, created: created.map((game) => newCharacter(game, now, exists)), duplicates, unmatched, ambiguous };
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
      newImages: plan.updates.filter((u) => u.images?.pending.length).length + plan.created.length,
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
  const { tables, translations } = await loadGameData(GAME_TABLES, [...OPTIONAL_GAME_TABLES, ...SUMMON_TABLES]);
  const dict = createDictionary(tables.m_dictionary, translations);
  const gameCharacters = buildCharacters(tables, dict);
  const siteCharacters = await db.collection('characters').find({}).toArray();
  const languages = translations.map((t) => t.language);
  // Only images present in the game files are queued: missing ones are not retried at every upload
  const exists = await createRmfsIndex(indexedRmfsFolders(languages));
  const plan = planGameSync(siteCharacters, gameCharacters, new Date(), exists);
  const preview = previewOf(plan, dict.languages);
  const banners = buildGameBanners(gameCharacters, languages, createSummonDetails(tables, dict), createSummonCatalog(tables, dict));
  const knownBanners = new Set(await db.collection('banners').distinct('gacha_group_id', { source: GAME_BANNER_SOURCE }));
  preview.statistics.banners = banners.length;
  preview.statistics.newBanners = banners.filter((b) => !knownBanners.has(b.gacha_group_id)).length;
  preview.statistics.legacyBanners = await db.collection('banners').countDocuments(legacyBannersFilter);
  preview.statistics.bannerImages = await countBannerImagesToQueue(db, banners, exists);
  // Models whose animations gave the hits of melee attacks
  preview.statistics.attackHitModels = new Set(tables.attack_hits.map((r) => r.resource_3d_id)).size;
  const accessories = buildAccessories(tables, dict);
  const subeffects = buildSubeffects(tables, dict);
  Object.assign(preview.statistics, await accessoryChanges(db, accessories));
  const bonusAbilities = buildBonusAbilities(tables, dict);
  Object.assign(preview.statistics, await bonusAbilityChanges(db, bonusAbilities));
  if (dryRun) return { dryRun: true, ...preview };

  await db.collection('app_settings').updateOne(
    { _id: TRAIT_FILTERS_SETTING },
    {
      $set: {
        categories: buildTraitFilters(tables, dict),
        special: buildSpecialFilters(tables, dict),
        destruction: buildDestructionFilters(tables, dict),
        languages: dict.languages,
        updated_at: new Date(),
      },
    },
    { upsert: true }
  );

  const ops = [
    ...plan.updates.filter((u) => u.changes.length > 0 || u.images).map((u) => ({
      updateOne: {
        filter: { _id: u.doc._id },
        update: u.images?.pending.length
          ? { $set: { ...u.set, ...u.images.set }, $addToSet: { images_pending: { $each: u.images.pending } } }
          : { $set: { ...u.set, ...u.images?.set } },
      },
    })),
    ...plan.created.map((doc) => ({ insertOne: { document: doc } })),
  ];
  if (ops.length > 0) await db.collection('characters').bulkWrite(ops, { ordered: false });
  const merged = await mergeDuplicates(db, plan.duplicates);
  await removeLegacyBanners(db);
  await saveGameBanners(db, banners, new Date(), exists);
  await saveAccessories(db, accessories, subeffects, new Date(), exists);
  await saveBonusAbilities(db, bonusAbilities);
  if (plan.created.length > 0 || plan.updates.some((u) => u.changes.some((field) => field === 'release_date' || field === 'book_order'))) await reorderCharactersByReleaseDate(db);
  return { dryRun: false, ...preview, merged };
};
