import sharp from 'sharp';
import { FTPUploader } from '../utils/ftp.js';
import { logger } from '../utils/logger.js';

// FTP folder of build screenshots (served by bucket.bbs-schrift.fr/builds/)
export const BUILD_SCREENSHOT_DIR = '/bucket.bbs-schrift.fr/builds';
// Maximum width after conversion
const MAX_WIDTH = 1600;
// Maximum uploaded image size (before conversion)
export const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

const pad = (n) => String(n).padStart(2, '0');

/**
 * Screenshot file name: <buildId>_<YYYYMMDD-HHmmss>.webp (UTC). The timestamp changes on every
 * replacement, so no cache serves the old image.
 */
export const screenshotFilename = (buildId, date = new Date()) =>
  `${buildId}_${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
  + `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}.webp`;

/**
 * Decodes an image sent as a data URL (or raw base64). Returns null when the content is not a usable
 * base64 image or exceeds the maximum size.
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

/** Converts a screenshot to WebP, auto-rotated and at most MAX_WIDTH pixels wide. */
export const toWebp = (buffer) =>
  sharp(buffer).rotate().resize({ width: MAX_WIDTH, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();

// FTP storage, replaceable in tests
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

/** Deletes a screenshot without failing the caller (file already gone, FTP unavailable…). */
export const removeScreenshot = async (filename) => {
  if (!filename) return;
  try {
    await storage.remove(filename);
  } catch (err) {
    logger.warn(`[builds] Suppression de la capture ${filename} impossible: ${err.message}`);
  }
};
