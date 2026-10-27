/**
 * Game summons in the `banners` collection (source: 'game', keyed by gacha_group_id), next to the
 * banners entered on the site. Their list visual is copied once from rmfs to the bucket: rmfs only
 * holds the summons the game client cached, a later dump may no longer have it.
 */
import { rmfsUrl } from './source.js';

export const GAME_BANNER_SOURCE = 'game';
const BUCKET_FOLDER = '/bucket.bbs-schrift.fr/banners';

export const gameBannerImagePath = (gachaGroupId) => `${BUCKET_FOLDER}/gacha_${gachaGroupId}.png`;

// One document per summon, from the summons listed on the game characters
export const buildGameBanners = (gameCharacters) => {
  const byGroup = new Map();
  for (const character of gameCharacters) {
    for (const summon of character.banners ?? []) {
      if (!byGroup.has(summon.gacha_group_id)) {
        byGroup.set(summon.gacha_group_id, {
          gacha_group_id: summon.gacha_group_id,
          name: summon.name?.fr ?? Object.values(summon.name ?? {})[0] ?? null,
          names: summon.name ?? null,
          start_date: summon.start_date,
          end_date: summon.end_date,
          image_source: summon.image_path ? rmfsUrl(`${summon.image_path}.png`) : null,
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
  const result = await db.collection('banners').bulkWrite(banners.map((banner) => ({
    updateOne: {
      filter: { gacha_group_id: banner.gacha_group_id },
      update: {
        $set: { ...banner, source: GAME_BANNER_SOURCE, updated_at: now },
        $setOnInsert: { image_status: 'missing', created_at: now },
      },
      upsert: true,
    },
  })), { ordered: false });
  // An image never copied yet is looked for again: this sync may come with a newer rmfs
  await db.collection('banners').updateMany(
    { source: GAME_BANNER_SOURCE, image_status: { $ne: 'uploaded' }, image_source: { $ne: null } },
    { $set: { image_status: 'pending' } }
  );
  return { created: result.upsertedCount };
};

const download = async (url) => {
  const response = await fetch(url);
  if (!response.ok) return { status: response.status };
  return { buffer: Buffer.from(await response.arrayBuffer()) };
};

// Copies pending summon visuals to the bucket; a visual rmfs does not have is marked missing
export const uploadGameBanners = async (db, ftp, limit) => {
  const pending = await db.collection('banners')
    .find({ source: GAME_BANNER_SOURCE, image_status: 'pending' })
    .limit(limit)
    .toArray();
  let uploaded = 0;
  for (const banner of pending) {
    const { buffer, status } = await download(banner.image_source).catch(() => ({ status: 0 }));
    if (buffer) {
      await ftp.uploadBuffer(buffer, gameBannerImagePath(banner.gacha_group_id));
      uploaded += 1;
    }
    // Not found or unreachable: tried again at the next sync, so the upload loop always ends
    await db.collection('banners').updateOne(
      { _id: banner._id },
      { $set: { image_status: buffer ? 'uploaded' : 'missing', image_error: buffer ? null : status, image_checked_at: new Date() } }
    );
  }
  return { uploaded, processed: pending.length };
};

export const pendingGameBanners = (db) => db.collection('banners').countDocuments({ source: GAME_BANNER_SOURCE, image_status: 'pending' });
