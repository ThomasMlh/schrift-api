import crypto from 'crypto';
import { Readable } from 'stream';
import { ObjectId } from 'mongodb';
import sharp from 'sharp';
import { FTPUploader } from '../../utils/ftp.js';
import { logger } from '../../utils/logger.js';
import { decodeImage } from '../buildScreenshots.js';
import { mediaCollection } from './index.js';

// FTP root served by bucket.bbs-schrift.fr; stored paths are relative to the bucket
const BUCKET_ROOT = '/bucket.bbs-schrift.fr';
const MAX_IMAGE_WIDTH = 1600;
// A Vercel request body stays under 4.5 MB: 3 MB of file is 4 MB once in base64
export const CHUNK_BYTES = 3 * 1024 * 1024;
export const MEDIA_LIMITS = {
  audio: { mime: ['audio/mpeg', 'audio/mp3'], extension: 'mp3', maxBytes: 10 * 1024 * 1024 },
  video: { mime: ['video/mp4'], extension: 'mp4', maxBytes: 30 * 1024 * 1024 },
};

const error = (statusCode, message) => Object.assign(new Error(message), { statusCode });

// FTP storage, replaceable in tests
const withFtp = async (task) => {
  const ftp = new FTPUploader();
  try {
    await ftp.connect();
    return await task(ftp);
  } finally {
    await ftp.disconnect();
  }
};
let storage = {
  write: (path, buffer) => withFtp((ftp) => ftp.uploadBuffer(buffer, `${BUCKET_ROOT}/${path}`)),
  append: (path, buffer) => withFtp((ftp) => ftp.client.appendFrom(Readable.from(buffer), `${BUCKET_ROOT}/${path}`)),
  remove: (path) => withFtp((ftp) => ftp.removeFile(`${BUCKET_ROOT}/${path}`)),
};
export const setQuizMediaStorage = (custom) => { storage = custom; };

// Random file names: a media cannot be found before its question shows it
const randomPath = (eventId, extension) => `quiz/${eventId}/${crypto.randomBytes(12).toString('hex')}.${extension}`;

const cleanName = (name) => String(name ?? '').trim().slice(0, 120) || 'fichier';

export const listMedia = (db, eventId) => mediaCollection(db).find({ event_id: eventId }).sort({ created_at: -1 }).toArray();

/** Image sent at once (already compressed by the browser), stored as WebP. */
export const uploadImage = async (db, eventId, { name, data }) => {
  const buffer = decodeImage(data);
  if (!buffer) throw error(400, 'Image invalide ou trop lourde (10 Mo maximum)');
  let webp;
  let meta;
  try {
    webp = await sharp(buffer).rotate().resize({ width: MAX_IMAGE_WIDTH, withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
    meta = await sharp(webp).metadata();
  } catch {
    throw error(400, 'Format d\'image non reconnu (PNG, JPG ou WebP)');
  }
  const path = randomPath(eventId, 'webp');
  await storage.write(path, webp);
  const doc = {
    event_id: eventId, kind: 'image', name: cleanName(name), path, size: webp.length,
    width: meta.width ?? null, height: meta.height ?? null, status: 'ready', created_at: new Date(),
  };
  const { insertedId } = await mediaCollection(db).insertOne(doc);
  return { _id: insertedId, ...doc };
};

/** Starts a chunked upload of an audio or video file. */
export const startUpload = async (db, eventId, { kind, name, size, mime }) => {
  const limits = MEDIA_LIMITS[kind];
  if (!limits) throw error(400, 'Type de média inconnu');
  if (!limits.mime.includes(mime)) throw error(400, kind === 'audio' ? 'Audio au format MP3 uniquement' : 'Vidéo au format MP4 uniquement');
  const bytes = Number(size);
  if (!(bytes > 0) || bytes > limits.maxBytes) throw error(400, `Fichier trop lourd (${limits.maxBytes / 1024 / 1024} Mo maximum)`);
  const doc = {
    event_id: eventId, kind, name: cleanName(name), path: randomPath(eventId, limits.extension), size: bytes,
    received: 0, chunks: 0, status: 'uploading', created_at: new Date(),
  };
  const { insertedId } = await mediaCollection(db).insertOne(doc);
  return { _id: insertedId, ...doc, chunk_bytes: CHUNK_BYTES };
};

const getMedia = async (db, id) => {
  if (!ObjectId.isValid(id)) throw error(400, 'Média invalide');
  const media = await mediaCollection(db).findOne({ _id: new ObjectId(id) });
  if (!media) throw error(404, 'Média introuvable');
  return media;
};

/** Adds the next chunk, in order (index 0, 1, 2…); the file becomes usable after the last one. */
export const uploadChunk = async (db, id, { index, data }) => {
  const media = await getMedia(db, id);
  if (media.status !== 'uploading') throw error(409, 'Envoi déjà terminé');
  if (Number(index) !== media.chunks) throw error(409, `Morceau attendu : ${media.chunks}`);
  const buffer = typeof data === 'string' ? Buffer.from(data, 'base64') : null;
  if (!buffer?.length || buffer.length > CHUNK_BYTES) throw error(400, 'Morceau invalide');
  if (media.received + buffer.length > media.size) throw error(400, 'Le fichier dépasse la taille annoncée');

  if (media.chunks === 0) await storage.write(media.path, buffer);
  else await storage.append(media.path, buffer);
  const received = media.received + buffer.length;
  const done = received === media.size;
  await mediaCollection(db).updateOne(
    { _id: media._id },
    { $set: { received, chunks: media.chunks + 1, ...(done && { status: 'ready' }) } },
  );
  return { received, size: media.size, status: done ? 'ready' : 'uploading' };
};

export const deleteMedia = async (db, id) => {
  const media = await getMedia(db, id);
  const used = await db.collection('quizzes').countDocuments({ event_id: media.event_id, 'questions.media_id': id });
  if (used) throw error(409, 'Ce média est utilisé par une question');
  try {
    await storage.remove(media.path);
  } catch (err) {
    logger.warn(`[quiz] Suppression du média ${media.path} impossible: ${err.message}`);
  }
  await mediaCollection(db).deleteOne({ _id: media._id });
};
