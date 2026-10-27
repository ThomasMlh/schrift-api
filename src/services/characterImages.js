/**
 * Character images stored on the bucket, one file per target, named after the character id.
 * The artwork target is the artwork with the silhouette laid over it when the source has one.
 */
import sharp from 'sharp';
import { logger } from '../utils/logger.js';

const BUCKET_ROOT = '/bucket.bbs-schrift.fr/characters';

export const IMAGE_TARGETS = [
  { key: 'thumbnail', folder: 'thumb', sources: ['thumbnail'] },
  { key: 'artwork', folder: 'artwork', sources: ['artwork', 'silhouette'] },
  { key: 'quote', folder: 'phrase', sources: ['quote'] },
  { key: 'quote_en', folder: 'phrase-en', sources: ['quote_en'] },
  { key: 'attack', folder: 'attack', sources: ['attack'] },
];

// Image read from the game files (rmfs, public on the bucket)
const isGameImage = (url) => url.includes('/rmfs/');

export const imagePath = (target, characterId) => `${BUCKET_ROOT}/${target.folder}/${characterId}.png`;

// Targets whose source URLs differ between the stored character and the new row
export const changedImageTargets = (previous = {}, next = {}) => IMAGE_TARGETS
  .filter((t) => t.sources.some((s) => (previous?.[s] ?? null) !== (next?.[s] ?? null)))
  .map((t) => t.key);

// Silhouette scaled onto the artwork canvas (never cropped, bottom aligned since the body is cut there), then drawn over it
export const composeArtwork = async (artwork, silhouette) => {
  const { width, height } = await sharp(artwork).metadata();
  const overlay = await sharp(silhouette)
    .resize(width, height, { fit: 'contain', position: 'bottom', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  return sharp(artwork).composite([{ input: overlay }]).png().toBuffer();
};

const download = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} pour ${url}`), { status: response.status });
  return Buffer.from(await response.arrayBuffer());
};

// The game artwork sits at the bottom of a square canvas, the rest is transparent
export const trimTransparent = (image) => sharp(image).trim().png().toBuffer();

/**
 * Uploads one target. Returns true when the stored file matches the source, 'missing' when a game
 * image does not exist (not every unit has a quote or a banner in the game files), false to retry:
 * a missing silhouette still uploads the plain artwork but returns false so the next batch tries again.
 */
export const uploadImageTarget = async (ftp, target, sources, characterId) => {
  const path = imagePath(target, characterId);
  const main = sources?.[target.sources[0]];
  if (!main) return true;

  if (isGameImage(main)) {
    try {
      const image = await download(main);
      await ftp.uploadBuffer(target.key === 'artwork' ? await trimTransparent(image) : image, path);
      return true;
    } catch (err) {
      if (err.status === 404 || err.status === 403) return 'missing';
      logger.error(`❌ Image du jeu ${target.key} ${characterId}:`, err.message);
      return false;
    }
  }

  if (target.key !== 'artwork' || !sources.silhouette) {
    return ftp.downloadAndUpload(main, path);
  }

  try {
    const artwork = await download(main);
    try {
      const silhouette = await download(sources.silhouette);
      await ftp.uploadBuffer(await composeArtwork(artwork, silhouette), path);
      return true;
    } catch (err) {
      logger.warn(`⚠️ Silhouette inutilisable pour ${characterId}: ${err.message}`);
      await ftp.uploadBuffer(artwork, path);
      return false;
    }
  } catch (err) {
    logger.error(`❌ Erreur artwork ${characterId}:`, err.message);
    return false;
  }
};
