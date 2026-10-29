/**
 * Character synchronization from SFTP and FTP image upload.
 */
import { cleanObject } from '../utils/cleaners.js';
import { SFTPClient } from '../utils/database.js';
import { FTPUploader } from '../utils/ftp.js';
import { notifyDiscord } from '../utils/notifyDiscord.js';
import { parseCSV, reorderCharactersByReleaseDate } from '../utils/characterHelpers.js';
import { buildCharacterMatcher, mapCharacterRow } from './characterSource.js';
import { IMAGE_TARGETS, changedImageTargets, imagePath, uploadImageTarget } from './characterImages.js';
import { pendingGameBanners, uploadGameBanners } from './gameDb/banners.js';
import { pendingAccessoryImages, uploadAccessoryImages } from './gameDb/accessories.js';
import { downloadGameFile } from './gameDb/source.js';
import { trackUploadRun } from './imageUploadRun.js';
import { logger } from '../utils/logger.js';

const buildSftpConfig = () => {
  const config = {
    host: process.env.SFTP_HOST,
    username: process.env.SFTP_USERNAME,
    password: process.env.SFTP_PASSWORD,
    port: parseInt(process.env.SFTP_PORT) || 22,
    readyTimeout: parseInt(process.env.SFTP_TIMEOUT) || 30000,
    retries: parseInt(process.env.SFTP_RETRIES) || 3,
    algorithms: {
      cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-gcm', 'aes256-gcm'],
      hmac: ['hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1'],
      kex: ['ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521', 'diffie-hellman-group14-sha256']
    },
    tryKeyboard: true
  };
  if (process.env.SFTP_PRIVATE_KEY) {
    config.privateKey = process.env.SFTP_PRIVATE_KEY;
    delete config.password;
  }
  return config;
}

const PREVIEW_LIMIT = 50;
// The bot keeps the up-to-date character file at the SFTP root (/modules/database.json is a stale copy)
const SOURCE_FILE_PATH = process.env.SFTP_CHARACTERS_PATH || '/database.json';

// What a sync would do, without writing anything
export const buildSyncPreview = (totalRows, planned) => {
  const counts = new Map();
  for (const p of planned) counts.set(p.mapped.searchName, (counts.get(p.mapped.searchName) ?? 0) + 1);
  const label = (p) => ({ search_name: p.mapped.searchName, name: p.mapped.data.name });

  const inserted = planned.filter((p) => !p.character);
  const renamed = planned.filter((p) => p.renamed);
  const updated = planned.filter((p) => p.character);
  const images = updated
    .map((p) => ({ ...label(p), targets: changedImageTargets(p.character.source_images, p.mapped.data.source_images) }))
    .filter((p) => p.targets.length > 0);

  return {
    dryRun: true,
    message: `Simulation : ${inserted.length} personnages créés, ${updated.length} mis à jour (dont ${renamed.length} renommés), ${images.length} avec de nouvelles images`,
    statistics: {
      totalProcessed: totalRows,
      inserted: inserted.length,
      updated: updated.length,
      renamed: renamed.length,
      skipped: totalRows - planned.length,
      imagesChanged: images.length,
      silhouettes: planned.filter((p) => p.mapped.data.source_images.silhouette).length,
    },
    preview: {
      inserted: inserted.slice(0, PREVIEW_LIMIT).map(label),
      renamed: renamed.slice(0, PREVIEW_LIMIT).map((p) => ({ ...label(p), previous: p.character.search_name })),
      images: images.slice(0, PREVIEW_LIMIT),
      duplicates: [...counts].filter(([, n]) => n > 1).map(([search_name, count]) => ({ search_name, count })),
    },
  };
};

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

export const syncCharactersFromSFTP = async (db, { uploadImages = false, dryRun = false } = {}) => {
  // Once characters come from the game tables, this file would bring back old names and create duplicates
  if (await db.collection('characters').findOne({ game_id: { $exists: true } }, { projection: { _id: 1 } })) {
    const err = new Error('Les personnages sont synchronisés depuis les tables du jeu : utilisez la synchro du jeu');
    err.statusCode = 409;
    throw err;
  }
  const sftpConfig = buildSftpConfig();

  if (!sftpConfig.host || !sftpConfig.username) {
    const err = new Error('Configuration SFTP incomplète. Vérifiez SFTP_HOST et SFTP_USERNAME');
    err.statusCode = 500;
    throw err;
  }
  if (!sftpConfig.password && !sftpConfig.privateKey) {
    const err = new Error('Authentification SFTP manquante. Définissez SFTP_PASSWORD ou SFTP_PRIVATE_KEY');
    err.statusCode = 500;
    throw err;
  }

  let fileContent;
  let sftpClient;
  try {
    sftpClient = new SFTPClient();
    await sftpClient.connect(sftpConfig);
    try {
      const exists = await sftpClient.client.exists(SOURCE_FILE_PATH);
      if (!exists) throw new Error(`Le fichier ${SOURCE_FILE_PATH} n'existe pas sur le serveur SFTP`);
    } catch (existsErr) {
      logger.warn('⚠️ Impossible de vérifier l\'existence du fichier:', existsErr.message);
    }
    const buffer = await sftpClient.client.get(SOURCE_FILE_PATH);
    fileContent = buffer.toString('utf8');
  } catch (sftpErr) {
    const err = new Error('Erreur lors de la connexion SFTP ou du téléchargement: ' + sftpErr.message);
    err.statusCode = 500;
    err.details = sftpErr.code ? `Code d'erreur: ${sftpErr.code}` : null;
    throw err;
  } finally {
    if (sftpClient) {
      try { await sftpClient.disconnect(); } catch { /* Ignore disconnect errors */ }
    }
  }

  let characters;
  try {
    characters = JSON.parse(fileContent);
  } catch {
    try {
      characters = parseCSV(fileContent);
    } catch (csvErr) {
      const err = new Error('Format de fichier non supporté. JSON ou CSV attendu.');
      err.statusCode = 400;
      throw err;
    }
  }

  if (!Array.isArray(characters)) {
    const err = new Error('Le fichier doit contenir un tableau de personnages');
    err.statusCode = 400;
    throw err;
  }

  const rows = characters.map((char, index) => ({ index, raw: char, mapped: mapCharacterRow(cleanObject(char)) }));
  const valid = rows.filter((r) => r.mapped);
  const stored = await db.collection('characters')
    .find({}, { projection: { search_name: 1, name: 1, source_images: 1 } })
    .toArray();
  const match = buildCharacterMatcher(stored, new Set(valid.map((r) => r.mapped.searchName)));
  const planned = valid.map((r) => ({ ...r, ...match(r.mapped) }));

  if (dryRun) return buildSyncPreview(characters.length, planned);

  let ftpUploader = null;
  if (uploadImages) {
    try {
      ftpUploader = new FTPUploader();
      await ftpUploader.connect();
    } catch (ftpErr) {
      logger.warn('⚠️ Impossible de se connecter au FTP images:', ftpErr.message);
    }
  }

  let insertedCount = 0, updatedCount = 0, renamedCount = 0, imagesUploaded = 0, bannersCreated = 0;
  let skippedCount = characters.length - valid.length;
  const errors = [];

  for (const { index, raw, mapped, character, renamed } of planned) {
    try {
      const { banner } = mapped;
      let bannerDoc = await db.collection('banners').findOne({ name: banner.name, portail: banner.portail });
      if (!bannerDoc && banner.name && banner.portail) {
        const newBanner = { name: banner.name, portail: banner.portail, url: banner.url || '' };
        const res = await db.collection('banners').insertOne(newBanner);
        bannerDoc = { _id: res.insertedId, ...newBanner };
        bannersCreated++;
        if (ftpUploader && banner.url) {
          const uploaded = await ftpUploader.downloadAndUpload(banner.url, `/bucket.bbs-schrift.fr/banners/${bannerDoc._id}.png`);
          if (uploaded) imagesUploaded++;
        }
      }

      const characterData = { ...mapped.data, banner_id: bannerDoc ? bannerDoc._id : null, updated_at: new Date() };
      let characterId;

      if (character) {
        const pending = changedImageTargets(character.source_images, characterData.source_images);
        const update = { $set: characterData };
        if (pending.length > 0) {
          update.$set.images_uploaded = false;
          update.$addToSet = { images_pending: { $each: pending } };
        }
        await db.collection('characters').updateOne({ _id: character._id }, update);
        // Keeps the next rows of the file (same name twice) comparing against what was just written
        character.source_images = characterData.source_images;
        characterId = character._id;
        updatedCount++;
        if (renamed) renamedCount++;
      } else {
        const res = await db.collection('characters').insertOne({
          ...characterData,
          images_uploaded: false,
          images_pending: IMAGE_TARGETS.map((t) => t.key),
          created_at: new Date(),
        });
        characterId = res.insertedId;
        insertedCount++;
      }

      if (ftpUploader) {
        const doc = await db.collection('characters').findOne({ _id: characterId }, { projection: { source_images: 1, images_pending: 1 } });
        imagesUploaded += (await uploadCharacterImages(db, ftpUploader, doc)).uploaded;
      }
    } catch (charErr) {
      errors.push({ index: index + 1, character: raw['Nom personnage'] || raw['Nom de recherche'] || 'Inconnu', error: charErr.message });
      skippedCount++;
    }
  }

  if (ftpUploader) {
    try { await ftpUploader.disconnect(); } catch { /* Ignore disconnect errors */ }
  }

  let reorderStats = null;
  try {
    reorderStats = await reorderCharactersByReleaseDate(db);
  } catch (reorderErr) {
    logger.error('⚠️ Erreur lors du tri automatique (non bloquant):', reorderErr);
  }

  const message = `Synchronisation terminée: ${insertedCount} personnages créés, ${updatedCount} mis à jour${renamedCount ? ` (dont ${renamedCount} renommés)` : ''}, ${bannersCreated} bannières créées, ${imagesUploaded} images uploadées${reorderStats ? ` - Tri automatique: ${reorderStats.updated} personnages réorganisés` : ''}`;
  const statistics = {
    totalProcessed: characters.length,
    inserted: insertedCount,
    updated: updatedCount,
    renamed: renamedCount,
    skipped: skippedCount,
    bannersCreated,
    imagesUploaded,
    errors: errors.length,
    reorderStats: reorderStats || null
  };

  await notifyDiscord('character_update', { message, statistics });

  return { message, statistics, errors: errors.slice(0, 10) };
}

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
