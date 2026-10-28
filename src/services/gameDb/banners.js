/**
 * Game summons in the `banners` collection (source: 'game', keyed by gacha_group_id). Their list visual
 * is localized: one per client language, the primary one in image_source / image_status, the others in
 * translations.<language>. Each is copied once from rmfs to the bucket: rmfs only holds the summons the
 * game client cached, a later dump may no longer have it.
 */
import { downloadGameFile, PRIMARY_LANGUAGE, rmfsUrl } from './source.js';

export const GAME_BANNER_SOURCE = 'game';
const BUCKET_FOLDER = '/bucket.bbs-schrift.fr/banners';

// gacha_866.png for the primary language, gacha_866.en.png for the others
export const gameBannerImagePath = (gachaGroupId, language = PRIMARY_LANGUAGE) => (
  `${BUCKET_FOLDER}/gacha_${gachaGroupId}${language === PRIMARY_LANGUAGE ? '' : `.${language}`}.png`
);

// Where the visual of a language is described on the document
const imageFields = (language) => (language === PRIMARY_LANGUAGE
  ? { source: 'image_source', status: 'image_status' }
  : { source: `translations.${language}.image_source`, status: `translations.${language}.image_status` });

const valueAt = (doc, path) => path.split('.').reduce((value, key) => value?.[key], doc);

// One document per summon, from the summons listed on the game characters
export const buildGameBanners = (gameCharacters, languages = []) => {
  const byGroup = new Map();
  for (const character of gameCharacters) {
    for (const summon of character.banners ?? []) {
      if (!byGroup.has(summon.gacha_group_id)) {
        const image = (language) => (summon.image_path ? rmfsUrl(`${summon.image_path}.png`, language) : null);
        byGroup.set(summon.gacha_group_id, {
          gacha_group_id: summon.gacha_group_id,
          name: summon.name?.[PRIMARY_LANGUAGE] ?? Object.values(summon.name ?? {})[0] ?? null,
          names: summon.name ?? null,
          start_date: summon.start_date,
          end_date: summon.end_date,
          image_source: image(PRIMARY_LANGUAGE),
          translation_sources: Object.fromEntries(languages.map((language) => [language, image(language)])),
          character_game_ids: [],
        });
      }
      byGroup.get(summon.gacha_group_id).character_game_ids.push(character.game_id);
    }
  }
  return [...byGroup.values()];
};

export const saveGameBanners = async (db, banners, now = new Date()) => {
  if (banners.length === 0) return { created: 0 };
  const result = await db.collection('banners').bulkWrite(banners.map(({ translation_sources: sources, ...banner }) => ({
    updateOne: {
      filter: { gacha_group_id: banner.gacha_group_id },
      update: {
        $set: {
          ...banner,
          ...Object.fromEntries(Object.entries(sources).map(([language, url]) => [imageFields(language).source, url])),
          source: GAME_BANNER_SOURCE,
          updated_at: now,
        },
        $setOnInsert: { created_at: now },
      },
      upsert: true,
    },
  })), { ordered: false });

  // Every visual not copied yet is looked for again: this sync may come with a newer rmfs
  const languages = [PRIMARY_LANGUAGE, ...new Set(banners.flatMap((b) => Object.keys(b.translation_sources)))];
  const docs = await db.collection('banners').find({ source: GAME_BANNER_SOURCE }).toArray();
  const ops = docs.map((doc) => ({
    updateOne: {
      filter: { _id: doc._id },
      update: {
        $set: {
          images_pending: languages.filter((language) => {
            const { source, status } = imageFields(language);
            return valueAt(doc, source) && valueAt(doc, status) !== 'uploaded';
          }),
        },
      },
    },
  }));
  if (ops.length > 0) await db.collection('banners').bulkWrite(ops, { ordered: false });
  return { created: result.upsertedCount };
};

const pendingFilter = { source: GAME_BANNER_SOURCE, 'images_pending.0': { $exists: true } };

// Copies pending summon visuals to the bucket; a visual rmfs does not have is marked missing
export const uploadGameBanners = async (db, ftp, limit) => {
  const pending = await db.collection('banners').find(pendingFilter).limit(limit).toArray();
  let uploaded = 0;
  for (const banner of pending) {
    for (const language of banner.images_pending) {
      const { source, status } = imageFields(language);
      const { buffer, error } = await downloadGameFile(ftp, valueAt(banner, source))
        .then((data) => ({ buffer: data }))
        .catch((err) => ({ error: err.status ?? 0 }));
      if (buffer) {
        await ftp.uploadBuffer(buffer, gameBannerImagePath(banner.gacha_group_id, language));
        uploaded += 1;
      }
      // Not found or unreachable: tried again at the next sync, so the upload loop always ends
      await db.collection('banners').updateOne(
        { _id: banner._id },
        { $set: { [status]: buffer ? 'uploaded' : 'missing', image_checked_at: new Date() }, $pull: { images_pending: language } }
      );
      if (!buffer && language === PRIMARY_LANGUAGE) {
        await db.collection('banners').updateOne({ _id: banner._id }, { $set: { image_error: error } });
      }
    }
  }
  return { uploaded, processed: pending.length };
};

// Banners entered on the site before the game data: replaced by the game summons, removed once.
// Game summons are never removed, even when a later version of the tables no longer lists them.
export const legacyBannersFilter = { source: { $ne: GAME_BANNER_SOURCE } };

export const removeLegacyBanners = async (db) => {
  const { deletedCount } = await db.collection('banners').deleteMany(legacyBannersFilter);
  await db.collection('characters').updateMany({ banner_id: { $exists: true } }, { $unset: { banner_id: '' } });
  return deletedCount;
};

export const pendingGameBanners = (db) => db.collection('banners').countDocuments(pendingFilter);
