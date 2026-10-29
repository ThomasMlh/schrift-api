/**
 * Upload of the character images (and the game summon and accessory visuals) to the bucket, in batches.
 */
import { FTPUploader } from '../utils/ftp.js';
import { IMAGE_TARGETS, imagePath, uploadImageTarget } from './characterImages.js';
import { pendingGameBanners, uploadGameBanners } from './gameDb/banners.js';
import { pendingAccessoryImages, uploadAccessoryImages } from './gameDb/accessories.js';
import { downloadGameFile } from './gameDb/source.js';
import { trackUploadRun } from './imageUploadRun.js';

/**
 * Uploads the pending targets of a character, plus any file missing from the bucket.
 * Clears the pending list once everything is uploaded and bumps images_version so browsers reload them.
 */
export const uploadCharacterImages = async (db, ftp, character) => {
  const pending = new Set(character.images_pending ?? []);
  let uploaded = 0;
  let complete = true;
  const done = [];
  const missing = [];

  for (const target of IMAGE_TARGETS) {
    if (!character.source_images?.[target.sources[0]]) {
      done.push(target.key);
      continue;
    }
    if (!pending.has(target.key) && await ftp.fileExists(imagePath(target, character._id))) continue;
    const result = await uploadImageTarget(ftp, target, character.source_images, character._id, character);
    if (result === 'missing') {
      missing.push(target.sources[0]);
      done.push(target.key);
    } else if (result) {
      uploaded++;
      done.push(target.key);
    } else {
      complete = false;
    }
  }

  const update = { $set: { images_uploaded: complete }, $pull: { images_pending: { $in: done } } };
  // The game has no such image for this unit: forget the source so the site does not show it
  for (const source of missing) update.$set[`source_images.${source}`] = null;
  if (uploaded > 0) update.$set.images_version = Date.now();
  // A failed character waits before the next try, so the batch loop does not spin on it
  if (complete) update.$unset = { images_failed_at: '' };
  else update.$set.images_failed_at = new Date();
  await db.collection('characters').updateOne({ _id: character._id }, update);
  return { uploaded, complete };
};

const RETRY_DELAY_MS = 60 * 60 * 1000;

// Outside production the API uses a copy of the prod characters with the same ids, and image files are
// named after the id on the shared bucket: only characters created by the game sync, unknown to prod, are uploaded
const devOnlyFilter = () => (process.env.NODE_ENV === 'production' ? {} : { created_by_game_sync: true });

const imagesToUploadFilter = () => ({
  ...devOnlyFilter(),
  source_images: { $exists: true },
  images_uploaded: { $ne: true },
  $or: [{ images_failed_at: { $exists: false } }, { images_failed_at: { $lt: new Date(Date.now() - RETRY_DELAY_MS) } }],
});

export const uploadImagesBatch = async (db, batchSize = 100) => {
  batchSize = Math.min(parseInt(batchSize) || 100, 200);

  const remainingImages = async () => await db.collection('characters').countDocuments(imagesToUploadFilter())
    + await pendingGameBanners(db) + await pendingAccessoryImages(db);
  const remainingBefore = await remainingImages();
  const characters = await db.collection('characters')
    .find(imagesToUploadFilter())
    .limit(batchSize)
    .toArray();

  if (remainingBefore === 0) {
    return { message: 'Toutes les images sont déjà uploadées', statistics: { processed: 0, uploaded: 0, remaining: 0, errors: 0 }, errors: [] };
  }

  let ftpUploader;
  try {
    ftpUploader = new FTPUploader();
    await ftpUploader.connect();
  } catch (ftpErr) {
    const err = new Error('Impossible de se connecter au FTP: ' + ftpErr.message);
    err.statusCode = 500;
    throw err;
  }

  let uploaded = 0, processed = 0;
  const errors = [];

  for (const char of characters) {
    try {
      uploaded += (await uploadCharacterImages(db, ftpUploader, char)).uploaded;
      processed++;
    } catch (charErr) {
      errors.push({ character: char.search_name || char.name, error: charErr.message });
    }
  }

  // Summon visuals of the game, copied once from rmfs to the bucket
  const summons = await uploadGameBanners(db, ftpUploader, batchSize);
  const accessoryImages = await uploadAccessoryImages(db, ftpUploader, batchSize, downloadGameFile);

  try { await ftpUploader.disconnect(); } catch { /* Ignore disconnect errors */ }

  const bannersUploaded = summons.uploaded + accessoryImages.uploaded;

  const remaining = await remainingImages();
  const message = `Batch terminé: ${uploaded} images uploadées pour ${processed} personnages, ${bannersUploaded} bannières, ${remaining} restants`;
  const statistics = { processed, uploaded, bannersUploaded, remaining, errors: errors.length };

  // Discord only hears about the start, each quarter and the end of the whole upload
  await trackUploadRun(db, { remainingBefore, remainingAfter: remaining, uploaded: uploaded + bannersUploaded, errors: errors.length });

  return { message, statistics, errors: errors.slice(0, 10) };
}
