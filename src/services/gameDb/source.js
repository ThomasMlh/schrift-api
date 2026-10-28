/**
 * Where the game master tables are read: a local folder in development (GAME_DB_DIR), the FTP otherwise
 * (GAME_DB_FTP_PATH, outside the public bucket). Images stay in rmfs, served by the bucket.
 */
import { readFile } from 'fs/promises';
import { FTPUploader } from '../../utils/ftp.js';
import { parseCsv } from './csv.js';

const FTP_PATH = () => process.env.GAME_DB_FTP_PATH || '/game-db';
const RMFS_URL = () => process.env.GAME_RMFS_URL || 'https://bucket.bbs-schrift.fr/rmfs';
// Same rmfs folder seen from the FTP: reading it there avoids the bucket web server, which answers
// 503 to the bursts of requests a sync makes from Vercel
const RMFS_FTP_PATH = () => process.env.GAME_RMFS_FTP_PATH || '/bucket.bbs-schrift.fr/rmfs';

export const rmfsFtpPath = (url) => (url?.startsWith(`${RMFS_URL()}/`) ? `${RMFS_FTP_PATH()}${url.slice(RMFS_URL().length)}` : null);

// Game file as a buffer: through the FTP for rmfs, over HTTP otherwise; a missing file has status 404
export const downloadGameFile = async (ftp, url) => {
  const ftpPath = rmfsFtpPath(url);
  if (ftpPath) return ftp.downloadBuffer(ftpPath);
  const response = await fetch(url);
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} pour ${url}`), { status: response.status });
  return Buffer.from(await response.arrayBuffer());
};

export const rmfsUrl = (path) => `${RMFS_URL()}/${path}`;

// Game images of a unit in rmfs; the quote does not exist for every unit
export const rmfsImages = (game) => (game.resource_2d_id ? {
  thumbnail: `${RMFS_URL()}/Characters/${game.resource_2d_id}/thumb.png`,
  artwork: `${RMFS_URL()}/Characters/${game.resource_2d_id}/stand_gacha.png`,
  quote: `${RMFS_URL()}/CharacterGacha/TexturesDialog/dialog_${game.resource_2d_id}.png`,
} : {});

const downloadText = async (ftp, remotePath) => (await ftp.downloadBuffer(remotePath)).toString('utf8');

export const loadGameTables = async (names) => {
  const localDir = process.env.GAME_DB_DIR;
  if (localDir) {
    const entries = await Promise.all(names.map(async (name) => [name, parseCsv(await readFile(`${localDir}/${name}.csv`, 'utf8'))]));
    return Object.fromEntries(entries);
  }

  const ftp = new FTPUploader();
  try {
    await ftp.connect();
    const tables = {};
    for (const name of names) {
      try {
        tables[name] = parseCsv(await downloadText(ftp, `${FTP_PATH()}/${name}.csv`));
      } catch (err) {
        throw Object.assign(new Error(`Table ${name}.csv introuvable dans ${FTP_PATH()} (${err.message})`), { statusCode: 404 });
      }
    }
    return tables;
  } finally {
    await ftp.disconnect().catch(() => {});
  }
};
