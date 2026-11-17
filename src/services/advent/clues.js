import crypto from 'crypto';
import sharp from 'sharp';
import { FTPUploader } from '../../utils/ftp.js';
import { downloadGameFile } from '../gameDb/source.js';

// Clue pictures of the advent calendar. They are drawn from the character's game artwork and stored
// under a random name, so neither the file nor its address tells which character it is.

export const CLUE_TYPES = ['silhouette', 'zoom', 'blur', 'quote'];
const BUCKET_ROOT = '/bucket.bbs-schrift.fr';
const OUTPUT_WIDTH = 640;
const SHADOW = [24, 22, 38];

const withFtp = async (task) => {
  const ftp = new FTPUploader();
  try {
    await ftp.connect();
    return await task(ftp);
  } finally {
    await ftp.disconnect();
  }
};

// Storage and artwork source, replaceable in tests
let storage = {
  artwork: (url) => withFtp((ftp) => downloadGameFile(ftp, url)),
  write: (path, buffer) => withFtp((ftp) => ftp.uploadBuffer(buffer, `${BUCKET_ROOT}/${path}`)),
  remove: (path) => withFtp((ftp) => ftp.removeFile(`${BUCKET_ROOT}/${path}`)),
};
export const setAdventStorage = (custom) => { storage = { ...storage, ...custom }; };
export const removeClue = (path) => (path ? storage.remove(path) : null);

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
};

/** Zoom and blur settings of a clue, within the bounds the editor offers. */
export const sanitizeClueSettings = (input = {}) => ({
  x: clamp(input.x, 0, 1, 0.5),
  y: clamp(input.y, 0, 1, 0.3),
  scale: clamp(input.scale, 1.5, 8, 3),
  blur: clamp(input.blur, 4, 60, 18),
});

// The character's own shape: every visible pixel painted in one dark colour
const silhouette = async (image) => {
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) [data[i], data[i + 1], data[i + 2]] = SHADOW;
  return sharp(data, { raw: info }).trim();
};

const zoom = async (image, { x, y, scale }) => {
  const { width, height } = await image.metadata();
  const w = Math.max(16, Math.round(width / scale));
  const h = Math.max(16, Math.round(Math.min(height, width) / scale));
  const left = Math.round(Math.max(0, Math.min(width - w, x * width - w / 2)));
  const top = Math.round(Math.max(0, Math.min(height - h, y * height - h / 2)));
  return sharp(await image.extract({ left, top, width: w, height: h }).png().toBuffer());
};

/** Clue picture of a type from an artwork (PNG with transparency). */
export const renderClue = async (artwork, type, settings) => {
  const image = sharp(artwork);
  let result;
  if (type === 'silhouette') result = await silhouette(image);
  else if (type === 'zoom') result = await zoom(image, settings);
  else if (type === 'blur') result = sharp(await image.trim().png().toBuffer()).blur(settings.blur);
  else throw Object.assign(new Error('Type d\'indice sans image'), { statusCode: 400 });
  return result.resize({ width: OUTPUT_WIDTH, withoutEnlargement: false }).webp({ quality: 82 }).toBuffer();
};

/** Draws the clue of a case and stores it; returns its bucket path. */
export const storeClue = async (eventId, artworkUrl, type, settings) => {
  if (!artworkUrl) throw Object.assign(new Error('Ce perso n\'a pas d\'artwork du jeu'), { statusCode: 400 });
  let artwork;
  try {
    artwork = await storage.artwork(artworkUrl);
  } catch {
    throw Object.assign(new Error('Artwork du jeu introuvable pour ce perso'), { statusCode: 400 });
  }
  const buffer = await renderClue(artwork, type, settings);
  const path = `advent/${eventId}/${crypto.randomBytes(12).toString('hex')}.webp`;
  await storage.write(path, buffer);
  return path;
};
