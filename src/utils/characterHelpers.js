import { logger } from './logger.js';
/**
 * Helpers partagés pour les routes characters.
 */

export const convertDateToFormat = (dateValue) => {
  if (!dateValue) return null;

  if (typeof dateValue === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(dateValue)) {
    return dateValue;
  }

  if (typeof dateValue === 'number' || (typeof dateValue === 'string' && /^\d+$/.test(dateValue))) {
    const timestamp = typeof dateValue === 'string' ? parseInt(dateValue) : dateValue;
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return dateValue;
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${day}/${month}/${date.getFullYear()}`;
  }

  return dateValue;
}

export const parseCSV = (csvContent) => {
  const lines = csvContent.split('\n').filter(line => line.trim());
  if (lines.length < 2) {
    throw new Error('Fichier CSV invalide: au moins une ligne d\'en-tête et une ligne de données requises');
  }

  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  const characters = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
    if (values.length !== headers.length) {
      logger.warn(`Ligne ${i + 1} ignorée: nombre de colonnes incorrect`);
      continue;
    }
    const character = {};
    headers.forEach((header, index) => { character[header] = values[index] || ''; });
    characters.push(character);
  }

  return characters;
}

export const reorderCharactersByReleaseDate = async (db) => {
  const allCharacters = await db.collection('characters').find({}).toArray();

  const parseDate = (dateStr) => {
    if (!dateStr) return new Date('1900-01-01');
    if (dateStr instanceof Date) return dateStr;
    if (typeof dateStr === 'string' && dateStr.includes('/')) {
      const [day, month, year] = dateStr.split('/');
      return new Date(year, month - 1, day);
    }
    const parsed = new Date(dateStr);
    return isNaN(parsed.getTime()) ? new Date('1900-01-01') : parsed;
  };

  const sorted = allCharacters.sort((a, b) => {
    const diff = parseDate(b.release_date).getTime() - parseDate(a.release_date).getTime();
    return diff !== 0 ? diff : (a.name || '').localeCompare(b.name || '');
  });

  const bulkOps = sorted.map((char, index) => ({
    updateOne: {
      filter: { _id: char._id },
      update: { $set: { sort_order: index, sort_date_parsed: parseDate(char.release_date), updated_at: new Date() } }
    }
  }));

  const result = await db.collection('characters').bulkWrite(bulkOps);

  return {
    totalCharacters: allCharacters.length,
    updated: result.modifiedCount,
    firstCharacter: `${sorted[0]?.name} (${sorted[0]?.release_date})`,
    lastCharacter: `${sorted[sorted.length - 1]?.name} (${sorted[sorted.length - 1]?.release_date})`
  };
}
