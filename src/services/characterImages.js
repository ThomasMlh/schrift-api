/**
 * Character images stored on the bucket, one file per target, named after the character id.
 * The artwork target is the artwork with the silhouette laid over it when the source has one, or with
 * its game background behind it when the unit has one.
 */
import sharp from 'sharp';
import { logger } from '../utils/logger.js';
import { downloadGameFile, GENERATED_ATTACK_IMAGE } from './gameDb/source.js';
import { ATTACK_PIECES_PATH, renderAttackImage } from './attackImage.js';
import { renderQuoteImage } from './quoteImage.js';

const BUCKET_ROOT = '/bucket.bbs-schrift.fr/characters';

export const IMAGE_TARGETS = [
  { key: 'thumbnail', folder: 'thumb', sources: ['thumbnail'] },
  { key: 'artwork', folder: 'artwork', sources: ['artwork', 'silhouette', 'background'] },
  { key: 'quote', folder: 'phrase/fr', sources: ['quote'], language: 'fr' },
  { key: 'quote_en', folder: 'phrase/en', sources: ['quote'], language: 'en' },
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

// Share of a trimmed artwork that is opaque from which it already holds its own scenery
const OPAQUE_SCENERY = 0.98;
const hasScenery = async (trimmed) => {
  const { data, info } = await sharp(trimmed).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
  const opaque = data.reduce((count, alpha) => count + (alpha > 200 ? 1 : 0), 0);
  return opaque >= OPAQUE_SCENERY * info.width * info.height;
};

// Game screen of 1136x640, scaled up to the width of the recent artworks. Artworks are shown at 111% of
// their own size and backgrounds at 1399 px, both centred and bottom aligned: only that screen is kept.
const SCREEN = { width: 1260, height: 710 };
const SCREEN_SCALE = SCREEN.width / 1136;
const ARTWORK_SCALE = 1.11 * SCREEN_SCALE;
const BACKGROUND_SIZE = Math.round(1399 * SCREEN_SCALE);

const cropToScreen = (image, size) => image
  .resize(size, size)
  .extract({ left: Math.floor((size - SCREEN.width) / 2), top: size - SCREEN.height, ...SCREEN });

// Cut-out artwork laid on its background as the game shows it. An artwork with its own scenery stays as it is.
export const composeOnBackground = async (artwork, background) => {
  const trimmed = await trimTransparent(artwork);
  if (await hasScenery(trimmed)) return trimmed;
  const { width } = await sharp(artwork).metadata();
  const scene = await cropToScreen(sharp(background), BACKGROUND_SIZE).png().toBuffer();
  const unit = await cropToScreen(sharp(artwork), Math.round(width * ARTWORK_SCALE)).png().toBuffer();
  return sharp(scene).composite([{ input: unit }]).png().toBuffer();
};

// How each game image is prepared before upload. Bump GAME_IMAGE_REVISIONS when a treatment changes:
// the next sync uploads that image again for every character.
const GAME_IMAGE_PROCESSING = { artwork: trimTransparent };
export const GAME_IMAGE_REVISIONS = { thumbnail: 1, artwork: 1, quote: 3, quote_en: 2, attack: 2 };

// Button pieces of the game interface, read once per process from the bucket
const attackPieces = new Map();
const loadAttackPiece = (ftp) => (name) => {
  if (!attackPieces.has(name)) {
    const download = ftp.downloadBuffer(`${ATTACK_PIECES_PATH}/${name}.png`);
    attackPieces.set(name, download);
    download.catch(() => attackPieces.delete(name));
  }
  return attackPieces.get(name);
};

/**
 * Uploads one target. Returns true when the stored file matches the source, 'missing' when a game
 * image does not exist (not every unit has a quote or a banner in the game files), false to retry:
 * a missing silhouette still uploads the plain artwork but returns false so the next batch tries again.
 */
export const uploadImageTarget = async (ftp, target, sources, characterId, character = null) => {
  const path = imagePath(target, characterId);
  const main = sources?.[target.sources[0]];
  if (!main) return true;

  // Drawn from the attacks of the character, like the game battle screen
  if (main === GENERATED_ATTACK_IMAGE) {
    try {
      const image = await renderAttackImage(character?.attacks, loadAttackPiece(ftp));
      if (!image) return 'missing';
      await ftp.uploadBuffer(image, path);
      return true;
    } catch (err) {
      logger.error(`❌ Image des attaques ${characterId}:`, err.message);
      return false;
    }
  }

  if (isGameImage(main)) {
    try {
      const image = await downloadGameFile(ftp, main);
      if (target.key === 'artwork' && sources.background) {
        try {
          const background = await downloadGameFile(ftp, sources.background);
          await ftp.uploadBuffer(await composeOnBackground(image, background), path);
          return true;
        } catch (err) {
          logger.warn(`⚠️ Fond inutilisable pour ${characterId}: ${err.message}`);
          await ftp.uploadBuffer(await trimTransparent(image), path);
          return false;
        }
      }
      if (target.language) {
        await ftp.uploadBuffer(await renderQuoteImage(image, character?.quote?.[target.language]), path);
        return true;
      }
      const prepare = GAME_IMAGE_PROCESSING[target.key];
      await ftp.uploadBuffer(prepare ? await prepare(image) : image, path);
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
