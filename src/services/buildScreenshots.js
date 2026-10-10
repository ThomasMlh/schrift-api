import sharp from 'sharp';
import { FTPUploader } from '../utils/ftp.js';
import { logger } from '../utils/logger.js';

// Dossier des captures de builds sur le FTP (servi par bucket.bbs-schrift.fr/builds/)
export const BUILD_SCREENSHOT_DIR = '/bucket.bbs-schrift.fr/builds';
// Largeur maximale de la capture une fois convertie
const MAX_WIDTH = 1600;
// Taille maximale de l'image envoyée (avant conversion)
export const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

const pad = (n) => String(n).padStart(2, '0');

/**
 * Nom du fichier d'une capture : <buildId>_<AAAAMMJJ-HHmmss>.webp (heure UTC). L'horodatage change
 * à chaque remplacement, ce qui évite qu'un cache serve l'ancienne image.
 */
export const screenshotFilename = (buildId, date = new Date()) =>
  `${buildId}_${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
  + `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}.webp`;

/**
 * Décode une image envoyée en data URL (ou base64 brut). Renvoie null si le contenu n'est pas
 * une image base64 exploitable ou dépasse la taille maximale.
 */
export const decodeImage = (dataUrl) => {
  if (typeof dataUrl !== 'string' || !dataUrl) return null;
  const match = dataUrl.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
  const base64 = match ? match[1] : dataUrl;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) return null;
  const buffer = Buffer.from(base64, 'base64');
  if (buffer.length === 0 || buffer.length > MAX_SCREENSHOT_BYTES) return null;
  return buffer;
};

/** Convertit une capture en WebP, orientée et limitée à MAX_WIDTH pixels de large. */
export const toWebp = (buffer) =>
  sharp(buffer).rotate().resize({ width: MAX_WIDTH, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();

// Stockage FTP, remplaçable dans les tests
let storage = {
  upload: async (buffer, filename) => {
    const ftp = new FTPUploader();
    try {
      await ftp.connect();
      await ftp.uploadBuffer(buffer, `${BUILD_SCREENSHOT_DIR}/${filename}`);
    } finally {
      await ftp.disconnect();
    }
  },
  remove: async (filename) => {
    const ftp = new FTPUploader();
    try {
      await ftp.connect();
      await ftp.removeFile(`${BUILD_SCREENSHOT_DIR}/${filename}`);
    } finally {
      await ftp.disconnect();
    }
  },
};

export const setScreenshotStorage = (custom) => { storage = custom; };

export const uploadScreenshot = (buffer, filename) => storage.upload(buffer, filename);

/** Supprime une capture sans faire échouer l'appelant (fichier déjà absent, FTP indisponible…). */
export const removeScreenshot = async (filename) => {
  if (!filename) return;
  try {
    await storage.remove(filename);
  } catch (err) {
    logger.warn(`[builds] Suppression de la capture ${filename} impossible: ${err.message}`);
  }
};
