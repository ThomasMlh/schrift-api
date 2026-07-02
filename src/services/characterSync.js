/**
 * Logique de synchronisation des personnages depuis SFTP et d'upload des images FTP.
 * Extrait de characters.js pour réduire la taille du fichier de routes.
 */
import { ObjectId } from 'mongodb';
import { cleanObject } from '../utils/cleaners.js';
import { SFTPClient } from '../utils/database.js';
import { FTPUploader } from '../utils/ftp.js';
import { notifyDiscord } from '../utils/notifyDiscord.js';
import { convertDateToFormat, parseCSV, reorderCharactersByReleaseDate } from '../utils/characterHelpers.js';
import { buildSftpConfig } from '../utils/sftpConfig.js';

const CANCEL_RESISTANCE_MAP = {
  'Annul. Res. Bleue': 'B',
  'Annul. Res. Rouge': 'R',
  'Range Nullify': 'range'
};

const splitField = (raw, key1, key2, key3) => {
  if (raw?.trim()) return raw.split(',').map(s => s.trim()).filter(Boolean);
  return [key1, key2, key3].filter(Boolean);
}

export const syncCharactersFromSFTP = async (db, { uploadImages = false } = {}) => {
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

  // Téléchargement SFTP
  let fileContent;
  let sftpClient;
  try {
    sftpClient = new SFTPClient();
    await sftpClient.connect(sftpConfig);
    try {
      const exists = await sftpClient.client.exists('/modules/database.json');
      if (!exists) throw new Error('Le fichier /modules/database.json n\'existe pas sur le serveur SFTP');
    } catch (existsErr) {
      console.warn('⚠️ Impossible de vérifier l\'existence du fichier:', existsErr.message);
    }
    const buffer = await sftpClient.client.get('/modules/database.json');
    fileContent = buffer.toString('utf8');
  } catch (sftpErr) {
    const err = new Error('Erreur lors de la connexion SFTP ou du téléchargement: ' + sftpErr.message);
    err.statusCode = 500;
    err.details = sftpErr.code ? `Code d'erreur: ${sftpErr.code}` : null;
    throw err;
  } finally {
    if (sftpClient) {
      try { await sftpClient.disconnect(); } catch { /* ignore */ }
    }
  }

  // Parsing du fichier
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

  // Connexion FTP si upload demandé
  let ftpUploader = null;
  if (uploadImages) {
    try {
      ftpUploader = new FTPUploader();
      await ftpUploader.connect();
    } catch (ftpErr) {
      console.warn('⚠️ Impossible de se connecter au FTP images:', ftpErr.message);
    }
  }

  let insertedCount = 0, updatedCount = 0, skippedCount = 0, imagesUploaded = 0, bannersCreated = 0;
  const errors = [];

  for (const [index, char] of characters.entries()) {
    try {
      const c = cleanObject(char);
      if (!c['Nom de recherche']?.trim()) { skippedCount++; continue; }

      const searchName = c['Nom de recherche'].replace(/[^\w\sàâäéèêëïîôöùûüÿç]/g, '').trim();
      const killers = splitField(c['Killers'], c['Killer 1'], c['Killer 2']);
      const categories = splitField(c['Catégories'], c['Catégorie 1'], c['Catégorie 2']);
      const soul_traits = splitField(c['Soul Traits'], c['Soul Trait 1'], c['Soul Trait 2']);
      const ex_soul_traits = splitField(c['Ex Soul Traits'], c['Ex Soul Trait 1'], c['Ex Soul Trait 2']);
      const immunities = splitField(c['Immunités'], c['Immunité 1'], c['Immunité 2'], c['Immunité 3']);

      let bannerDoc = await db.collection('banners').findOne({ name: c['Loterie'], portail: c['Portail'] });
      if (!bannerDoc && c['Loterie'] && c['Portail']) {
        const newBanner = { name: c['Loterie'], portail: c['Portail'], url: c['URL Portail'] || '' };
        const res = await db.collection('banners').insertOne(newBanner);
        bannerDoc = { _id: res.insertedId, ...newBanner };
        bannersCreated++;
        if (ftpUploader && c['URL Portail']) {
          const uploaded = await ftpUploader.downloadAndUpload(c['URL Portail'], `/bucket.bbs-schrift.fr/banners/${bannerDoc._id}.png`);
          if (uploaded) imagesUploaded++;
        }
      }

      const characterData = {
        name: c['Nom personnage'] || '',
        search_name: searchName,
        affinity: c['Affinité'] || '',
        rarity: c['Rareté'] || '',
        categories,
        killers,
        soul_traits,
        ex_soul_traits,
        attack_type: c['Attaques Rouges ou Bleues'] === 'Attaques B' ? 'B' : 'R',
        release_date: convertDateToFormat(c['Date sortie']),
        resurrection_release: convertDateToFormat(c['Date résurrection']),
        nad: c['NAD ou SAD'] === 'NAD' ? 'NAD' : false,
        sad: c['NAD ou SAD'] === 'SAD' ? 'SAD' : false,
        version: c['Version'] || '',
        version_name: c['Nom version'] || '',
        banner_id: bannerDoc ? bannerDoc._id : null,
        stats: { end: c['END'] || null, atk: c['ATK'] || null, def: c['DEF'] || null, cct: c['CCT'] || null, pre: c['PRE'] || null },
        immunities,
        cancel_resistance: CANCEL_RESISTANCE_MAP[c['Annulation résistance Rouge/Bleue']] || null,
        source_images: {
          thumbnail: c['Link'] || null,
          artwork: c['URL Artwork'] || null,
          quote: c['URL Phrase'] || null,
          attack: c['URL ATK'] || null
        },
        updated_at: new Date()
      };

      const existing = await db.collection('characters').findOne({ search_name: searchName });
      let characterId;

      if (existing) {
        await db.collection('characters').updateOne({ search_name: searchName }, { $set: characterData });
        characterId = existing._id;
        updatedCount++;
      } else {
        characterData.created_at = new Date();
        const res = await db.collection('characters').insertOne(characterData);
        characterId = res.insertedId;
        insertedCount++;
      }

      if (ftpUploader && characterId) {
        const imageFields = [
          { field: 'Link', path: `/bucket.bbs-schrift.fr/characters/thumb/${characterId}.png` },
          { field: 'URL Artwork', path: `/bucket.bbs-schrift.fr/characters/artwork/${characterId}.png` },
          { field: 'URL Phrase', path: `/bucket.bbs-schrift.fr/characters/phrase/${characterId}.png` },
          { field: 'URL ATK', path: `/bucket.bbs-schrift.fr/characters/attack/${characterId}.png` }
        ];
        for (const img of imageFields) {
          if (!c[img.field]) continue;
          if (existing && await ftpUploader.fileExists(img.path)) continue;
          if (await ftpUploader.downloadAndUpload(c[img.field], img.path)) imagesUploaded++;
        }
      }
    } catch (charErr) {
      errors.push({ index: index + 1, character: char['Nom personnage'] || char['Nom de recherche'] || 'Inconnu', error: charErr.message });
      skippedCount++;
    }
  }

  if (ftpUploader) {
    try { await ftpUploader.disconnect(); } catch { /* ignore */ }
  }

  let reorderStats = null;
  try {
    reorderStats = await reorderCharactersByReleaseDate(db);
  } catch (reorderErr) {
    console.error('⚠️ Erreur lors du tri automatique (non bloquant):', reorderErr);
  }

  const message = `Synchronisation terminée: ${insertedCount} personnages créés, ${updatedCount} mis à jour, ${bannersCreated} bannières créées, ${imagesUploaded} images uploadées${reorderStats ? ` - Tri automatique: ${reorderStats.updated} personnages réorganisés` : ''}`;
  const statistics = {
    totalProcessed: characters.length,
    inserted: insertedCount,
    updated: updatedCount,
    skipped: skippedCount,
    bannersCreated,
    imagesUploaded,
    errors: errors.length,
    reorderStats: reorderStats || null
  };

  notifyDiscord('character_update', { message, statistics });

  return { message, statistics, errors: errors.slice(0, 10) };
}

export const uploadImagesBatch = async (db, batchSize = 100) => {
  batchSize = Math.min(parseInt(batchSize) || 100, 200);

  const characters = await db.collection('characters')
    .find({ source_images: { $exists: true }, images_uploaded: { $ne: true } })
    .limit(batchSize)
    .toArray();

  if (characters.length === 0) {
    const remaining = await db.collection('characters').countDocuments({ source_images: { $exists: true }, images_uploaded: { $ne: true } });
    return { message: 'Toutes les images sont déjà uploadées', statistics: { processed: 0, uploaded: 0, remaining, errors: 0 }, errors: [] };
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
      const imageFields = [
        { key: 'thumbnail', path: `/bucket.bbs-schrift.fr/characters/thumb/${char._id}.png` },
        { key: 'artwork', path: `/bucket.bbs-schrift.fr/characters/artwork/${char._id}.png` },
        { key: 'quote', path: `/bucket.bbs-schrift.fr/characters/phrase/${char._id}.png` },
        { key: 'attack', path: `/bucket.bbs-schrift.fr/characters/attack/${char._id}.png` }
      ];

      let allUploaded = true;
      for (const img of imageFields) {
        const sourceUrl = char.source_images?.[img.key];
        if (!sourceUrl || await ftpUploader.fileExists(img.path)) continue;
        if (await ftpUploader.downloadAndUpload(sourceUrl, img.path)) {
          uploaded++;
        } else {
          allUploaded = false;
        }
      }

      if (allUploaded) {
        await db.collection('characters').updateOne({ _id: char._id }, { $set: { images_uploaded: true } });
      }
      processed++;
    } catch (charErr) {
      errors.push({ character: char.search_name || char.name, error: charErr.message });
    }
  }

  try { await ftpUploader.disconnect(); } catch { /* ignore */ }

  // Bannières manquantes
  let bannersUploaded = 0;
  const bannersToUpload = await db.collection('banners')
    .find({ url: { $exists: true, $ne: '' }, images_uploaded: { $ne: true } })
    .limit(batchSize)
    .toArray();

  if (bannersToUpload.length > 0) {
    try {
      const bannerFtp = new FTPUploader();
      await bannerFtp.connect();
      for (const banner of bannersToUpload) {
        const path = `/bucket.bbs-schrift.fr/banners/${banner._id}.png`;
        if (banner.url && !await bannerFtp.fileExists(path)) {
          if (await bannerFtp.downloadAndUpload(banner.url, path)) bannersUploaded++;
        }
        await db.collection('banners').updateOne({ _id: banner._id }, { $set: { images_uploaded: true } });
      }
      try { await bannerFtp.disconnect(); } catch { /* ignore */ }
    } catch (bannerErr) {
      console.warn('⚠️ Erreur upload bannières:', bannerErr.message);
    }
  }

  const remaining = await db.collection('characters').countDocuments({ source_images: { $exists: true }, images_uploaded: { $ne: true } });
  const message = `Batch terminé: ${uploaded} images uploadées pour ${processed} personnages, ${bannersUploaded} bannières, ${remaining} restants`;
  const statistics = { processed, uploaded, bannersUploaded, remaining, errors: errors.length };

  notifyDiscord('image_upload', { message, statistics });

  return { message, statistics, errors: errors.slice(0, 10) };
}
