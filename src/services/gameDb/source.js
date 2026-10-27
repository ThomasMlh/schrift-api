/**
 * Where the game master tables are read: a local folder in development (GAME_DB_DIR), the FTP otherwise
 * (GAME_DB_FTP_PATH, outside the public bucket). Images stay in rmfs, served by the bucket.
 */
import { readFile } from 'fs/promises';
import { Writable } from 'stream';
import { FTPUploader } from '../../utils/ftp.js';
import { parseCsv } from './csv.js';

const FTP_PATH = () => process.env.GAME_DB_FTP_PATH || '/game-db';
const RMFS_URL = () => process.env.GAME_RMFS_URL || 'https://bucket.bbs-schrift.fr/rmfs';

export const rmfsImages = (resource2dId) => (resource2dId ? {
  thumbnail: `${RMFS_URL()}/Characters/${resource2dId}/thumb.png`,
  artwork: `${RMFS_URL()}/Characters/${resource2dId}/stand_gacha.png`,
} : {});

const downloadText = async (ftp, remotePath) => {
  const chunks = [];
  const sink = new Writable({ write: (chunk, encoding, done) => { chunks.push(chunk); done(); } });
  await ftp.client.downloadTo(sink, remotePath);
  return Buffer.concat(chunks).toString('utf8');
};

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
