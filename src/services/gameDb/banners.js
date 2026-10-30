/**
 * Game summons in the `banners` collection (source: 'game', keyed by gacha_group_id). Their visual is
 * localized: one per client language, the primary one in image_status, the others in
 * translations.<language>. Each is copied once to the bucket: the official banner of the summon news
 * when it has one (the English one falls back to the primary), otherwise the list visual of rmfs, which
 * only holds the summons the game client cached. A ticket has no banner: its visual is the item icon.
 */
import { downloadGameFile, PRIMARY_LANGUAGE, rmfsUrl } from './source.js';
import { TICKET_CATEGORIES } from './summons.js';
import { downloadNewsBanner, newsBannerUrl, readSummonNews } from './summonNews.js';

export const GAME_BANNER_SOURCE = 'game';
const BUCKET_FOLDER = '/bucket.bbs-schrift.fr/banners';

// gacha_866.png for the primary language, gacha_866.en.png for the others
export const gameBannerImagePath = (gachaGroupId, language = PRIMARY_LANGUAGE) => (
  `${BUCKET_FOLDER}/gacha_${gachaGroupId}${language === PRIMARY_LANGUAGE ? '' : `.${language}`}.png`
);

// Where the visual of a language is described on the document
const imageFields = (language) => (language === PRIMARY_LANGUAGE
  ? { source: 'image_source', status: 'image_status', origin: 'image_origin' }
  : {
    source: `translations.${language}.image_source`,
    status: `translations.${language}.image_status`,
    origin: `translations.${language}.image_origin`,
  });

// A visual is worth trying when the summon has a news (official banner) or rmfs has its list visual
const isTicket = (summon) => TICKET_CATEGORIES.includes(summon?.list_category);
const officialNewsId = (summon) => (isTicket(summon) ? null : summon?.details?.news_id);
const canQueue = (summon, url, exists) => Boolean(officialNewsId(summon)) || Boolean(url && exists(url));

const valueAt = (doc, path) => path.split('.').reduce((value, key) => value?.[key], doc);

// One document per summon, from the summons listed on the game characters and the catalog of all summons.
// detailsOf(group) adds what the summon tables tell (modes, steps, featured units, medal shop)
export const buildGameBanners = (gameCharacters, languages = [], detailsOf = () => null, catalog = []) => {
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
          details: detailsOf(summon.gacha_group_id),
        });
      }
      byGroup.get(summon.gacha_group_id).character_game_ids.push(character.game_id);
    }
  }
  for (const { name, image_path: imagePath, ticket_icon_path: iconPath, ...entry } of catalog) {
    const image = (language) => (imagePath ? rmfsUrl(`${imagePath}.png`, language) : null);
    const banner = byGroup.get(entry.gacha_group_id) ?? {
      name: name?.[PRIMARY_LANGUAGE] ?? Object.values(name ?? {})[0] ?? null,
      names: name,
      image_source: image(PRIMARY_LANGUAGE),
      translation_sources: Object.fromEntries(languages.map((language) => [language, image(language)])),
      character_game_ids: [],
      details: detailsOf(entry.gacha_group_id),
    };
    byGroup.set(entry.gacha_group_id, {
      ...banner,
      ...entry,
      ...(iconPath && { image_source: rmfsUrl(iconPath), translation_sources: {} }),
    });
  }
  return [...byGroup.values()];
};

// exists(url) tells whether a visual is in rmfs: only those are queued for upload
export const saveGameBanners = async (db, banners, now = new Date(), exists = () => true) => {
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

  // A visual not copied yet is queued as soon as the game files have it
  const languages = [PRIMARY_LANGUAGE, ...new Set(banners.flatMap((b) => Object.keys(b.translation_sources)))];
  const docs = await db.collection('banners').find({ source: GAME_BANNER_SOURCE }).toArray();
  const ops = docs.map((doc) => ({
    updateOne: {
      filter: { _id: doc._id },
      update: {
        $set: {
          images_pending: languages.filter((language) => {
            const { source, status } = imageFields(language);
            return valueAt(doc, status) !== 'uploaded' && canQueue(doc, valueAt(doc, source), exists);
          }),
        },
      },
    },
  }));
  if (ops.length > 0) await db.collection('banners').bulkWrite(ops, { ordered: false });
  return { created: result.upsertedCount };
};

// Visuals a sync would queue: present in rmfs and not copied yet, for the preview
export const countBannerImagesToQueue = async (db, banners, exists = () => true) => {
  const stored = new Map((await db.collection('banners').find({ source: GAME_BANNER_SOURCE }).toArray()).map((doc) => [doc.gacha_group_id, doc]));
  let count = 0;
  for (const banner of banners) {
    const doc = stored.get(banner.gacha_group_id);
    const sources = { [PRIMARY_LANGUAGE]: banner.image_source, ...banner.translation_sources };
    for (const [language, url] of Object.entries(sources)) {
      if (canQueue(banner, url, exists) && valueAt(doc, imageFields(language).status) !== 'uploaded') count += 1;
    }
  }
  return count;
};

// Official banners are downloaded from the game servers: fewer per batch keeps it within the function time
const BANNER_BATCH_LIMIT = 25;

const pendingFilter = { source: GAME_BANNER_SOURCE, 'images_pending.0': { $exists: true } };

// Official banners per summon news, read once per batch: several summons may share a news
const createOfficialBanners = (ftp) => {
  const cache = new Map();
  return (newsId, language) => {
    const key = `${newsId}/${language}`;
    if (!cache.has(key)) {
      cache.set(key, (async () => {
        const html = await readSummonNews(ftp, newsId);
        const url = newsBannerUrl(html, language);
        return url ? downloadNewsBanner(url) : null;
      })());
    }
    return cache.get(key);
  };
};

// Visual of a summon in a language: the official banner, the primary one for a language the news does
// not have, then the rmfs list visual
const summonVisual = async (ftp, banner, language, officialBanner) => {
  const newsId = officialNewsId(banner);
  if (newsId) {
    const official = await officialBanner(newsId, language).catch(() => null);
    if (official) return { buffer: official, origin: 'official' };
    if (language !== PRIMARY_LANGUAGE) {
      const primary = await officialBanner(newsId, PRIMARY_LANGUAGE).catch(() => null);
      if (primary) return { buffer: primary, origin: `official-${PRIMARY_LANGUAGE}` };
    }
  }
  const url = valueAt(banner, imageFields(language).source);
  if (!url) return { error: 404 };
  return downloadGameFile(ftp, url)
    .then((buffer) => ({ buffer, origin: 'game' }))
    .catch((err) => ({ error: err.status ?? 0 }));
};

// Copies pending summon visuals to the bucket; a summon with no visual at all is marked missing
export const uploadGameBanners = async (db, ftp, limit) => {
  const pending = await db.collection('banners').find(pendingFilter).limit(Math.min(limit, BANNER_BATCH_LIMIT)).toArray();
  const officialBanner = createOfficialBanners(ftp);
  let uploaded = 0;
  for (const banner of pending) {
    for (const language of banner.images_pending) {
      const { status, origin } = imageFields(language);
      const { buffer, origin: from, error } = await summonVisual(ftp, banner, language, officialBanner);
      if (buffer) {
        await ftp.uploadBuffer(buffer, gameBannerImagePath(banner.gacha_group_id, language));
        uploaded += 1;
      }
      // Not found or unreachable: tried again at the next sync, so the upload loop always ends
      await db.collection('banners').updateOne(
        { _id: banner._id },
        {
          $set: { [status]: buffer ? 'uploaded' : 'missing', ...(buffer && { [origin]: from }), image_checked_at: new Date() },
          $pull: { images_pending: language },
        }
      );
      if (!buffer && language === PRIMARY_LANGUAGE) {
        await db.collection('banners').updateOne({ _id: banner._id }, { $set: { image_error: error ?? 404 } });
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
