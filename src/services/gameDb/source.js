/**
 * Where the game master tables are read: a local folder in development (GAME_DB_DIR), the FTP otherwise
 * (GAME_DB_FTP_PATH, outside the public bucket), one sub-folder per client language (fr, en...).
 * Images stay in rmfs, served by the bucket, with the same language folders.
 */
import { readdir, readFile } from 'fs/promises';
import { FTPUploader } from '../../utils/ftp.js';
import { parseCsv } from './csv.js';

const FTP_PATH = () => process.env.GAME_DB_FTP_PATH || '/game-db';
const RMFS_URL = () => process.env.GAME_RMFS_URL || 'https://bucket.bbs-schrift.fr/rmfs';
// Same rmfs folder seen from the FTP: reading it there avoids the bucket web server, which answers
// 503 to the bursts of requests a sync makes from Vercel
const RMFS_FTP_PATH = () => process.env.GAME_RMFS_FTP_PATH || '/bucket.bbs-schrift.fr/rmfs';

// Every game dump is stored in a folder per client language (game-db/fr, rmfs/fr...). The primary one
// gives all the game data and the pictures without text; the others add their texts and summon visuals.
export const PRIMARY_LANGUAGE = process.env.GAME_PRIMARY_LANGUAGE || 'fr';
const LANGUAGE_FOLDER = /^[a-z]{2}$/;

export const rmfsFtpPath = (url) => (url?.startsWith(`${RMFS_URL()}/`) ? `${RMFS_FTP_PATH()}${url.slice(RMFS_URL().length)}` : null);

// Game file as a buffer: through the FTP for rmfs, over HTTP otherwise; a missing file has status 404
export const downloadGameFile = async (ftp, url) => {
  const ftpPath = rmfsFtpPath(url);
  if (ftpPath) return ftp.downloadBuffer(ftpPath);
  const response = await fetch(url);
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status} pour ${url}`), { status: response.status });
  return Buffer.from(await response.arrayBuffer());
};

export const rmfsUrl = (path, language = PRIMARY_LANGUAGE) => `${RMFS_URL()}/${language}/${path}`;

// URL stored before rmfs had language folders -> the same file in the primary language folder
export const withLanguageFolder = (url) => {
  const prefix = `${RMFS_URL()}/`;
  if (!url?.startsWith(prefix) || LANGUAGE_FOLDER.test(url.slice(prefix.length).split('/')[0])) return url;
  return `${prefix}${PRIMARY_LANGUAGE}/${url.slice(prefix.length)}`;
};

// Game images of a unit in rmfs; the quote does not exist for every unit
export const rmfsImages = (game) => (game.resource_2d_id ? {
  thumbnail: rmfsUrl(`Characters/${game.resource_2d_id}/thumb.png`),
  artwork: rmfsUrl(`Characters/${game.resource_2d_id}/stand_gacha.png`),
  quote: rmfsUrl(`CharacterGacha/TexturesDialog/dialog_${game.resource_2d_id}.png`),
} : {});

const downloadText = async (ftp, remotePath) => (await ftp.downloadBuffer(remotePath)).toString('utf8');

// Reads the tables of the primary language folder and the dictionary of every other language folder
const readGameData = async ({ listFolders, readTable, root }, names) => {
  const folders = (await listFolders(root)).filter((name) => LANGUAGE_FOLDER.test(name));
  const primary = `${root}/${PRIMARY_LANGUAGE}`;
  const tables = {};
  for (const name of names) {
    try {
      tables[name] = parseCsv(await readTable(`${primary}/${name}.csv`));
    } catch (err) {
      throw Object.assign(new Error(`Table ${name}.csv introuvable dans ${primary} (${err.message})`), { statusCode: 404 });
    }
  }
  const translations = [];
  for (const language of folders.filter((name) => name !== PRIMARY_LANGUAGE)) {
    try {
      translations.push({ language, rows: parseCsv(await readTable(`${root}/${language}/m_dictionary.csv`)) });
    } catch {
      // A language folder without its dictionary only brings summon visuals
    }
  }
  return { tables, translations };
};

export const loadGameData = async (names) => {
  const localDir = process.env.GAME_DB_DIR;
  if (localDir) {
    return readGameData({
      root: localDir,
      listFolders: async (dir) => (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name),
      readTable: (path) => readFile(path, 'utf8'),
    }, names);
  }

  const ftp = new FTPUploader();
  try {
    await ftp.connect();
    return await readGameData({
      root: FTP_PATH(),
      listFolders: async (dir) => (await ftp.client.list(dir)).filter((item) => item.type === 2).map((item) => item.name),
      readTable: (path) => downloadText(ftp, path),
    }, names);
  } finally {
    await ftp.disconnect().catch(() => {});
  }
};
