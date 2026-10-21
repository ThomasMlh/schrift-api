/**
 * Maps a row of the character source file (database.json) to a `characters` document.
 * Accepts both the legacy columns and the current ones, so a file in either format syncs the same way.
 */
import { convertDateToFormat } from '../utils/characterHelpers.js';

const CANCEL_RESISTANCE_MAP = {
  'Annul. Res. Bleue': 'B',
  'Annul. Res. Rouge': 'R',
  'Range Nullify': 'range'
};

// The source file writes empty cells as null, "", "  " or the string "null"
export const nullable = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' || trimmed.toLowerCase() === 'null' ? null : trimmed;
  }
  return value;
};

// First non-empty value among the given columns (current name first, legacy names after)
const pick = (row, ...keys) => {
  for (const key of keys) {
    const value = nullable(row[key]);
    if (value !== null) return value;
  }
  return null;
};

// "A, B" in the combined column, otherwise the numbered columns
const splitField = (combined, ...singles) => {
  if (combined) return String(combined).split(',').map((s) => s.trim()).filter(Boolean);
  return singles.filter(Boolean);
};

export const toSearchName = (raw) => (nullable(raw) ? String(raw).replace(/[^\w\sàâäéèêëïîôöùûüÿç]/g, '').trim() : '');

export const mapCharacterRow = (row) => {
  const searchName = toSearchName(row['Nom de recherche']);
  if (!searchName) return null;

  const attackSide = pick(row, 'Attaques Rouges ou Bleues');
  const nadOrSad = pick(row, 'NAD ou SAD');

  return {
    searchName,
    banner: {
      name: pick(row, 'Loterie'),
      portail: pick(row, 'Portail'),
      url: pick(row, 'URL Portail'),
    },
    data: {
      name: pick(row, 'Nom personnage') || '',
      search_name: searchName,
      affinity: pick(row, 'Affinité') || '',
      rarity: pick(row, 'Rareté') || '',
      categories: splitField(pick(row, 'Catégories'), pick(row, 'Catégorie 1'), pick(row, 'Catégorie 2')),
      killers: splitField(pick(row, 'Killers'), pick(row, 'Killer 1'), pick(row, 'Killer 2')),
      soul_traits: splitField(pick(row, 'Soul Traits'), pick(row, 'Soul Trait 1'), pick(row, 'Soul Trait 2')),
      ex_soul_traits: splitField(
        pick(row, 'Compétences Ex', 'Ex Soul Traits'),
        pick(row, 'Compétence Ex 1', 'Ex Soul Trait 1'),
        pick(row, 'Compétence Ex 2', 'Ex Soul Trait 2'),
      ),
      attack_type: attackSide === 'Attaques B' ? 'B' : 'R',
      release_date: convertDateToFormat(pick(row, 'Date sortie')),
      resurrection_release: convertDateToFormat(pick(row, 'Date résurrection')),
      nad: nadOrSad === 'NAD' ? 'NAD' : false,
      sad: nadOrSad === 'SAD' ? 'SAD' : false,
      version: pick(row, 'Version') || '',
      version_name: pick(row, 'Nom version') || '',
      stats: {
        end: pick(row, 'END'), atk: pick(row, 'ATK'), def: pick(row, 'DEF'), cct: pick(row, 'CCT'), pre: pick(row, 'PRE'),
      },
      immunities: splitField(pick(row, 'Immunités'), pick(row, 'Immunité 1'), pick(row, 'Immunité 2'), pick(row, 'Immunité 3')),
      cancel_resistance: CANCEL_RESISTANCE_MAP[pick(row, 'Annulation résistance Rouge/Bleue')] || null,
      source_images: {
        thumbnail: pick(row, 'Link'),
        artwork: pick(row, 'URL Artwork'),
        silhouette: pick(row, 'URL Silhouette'),
        quote: pick(row, 'URL Phrase FR', 'URL Phrase'),
        quote_en: pick(row, 'URL Phrase EN'),
        attack: pick(row, 'URL ATK'),
      },
    },
  };
};

/**
 * Finds the stored character a row belongs to. The search name is the key; when it was renamed in the
 * source file, the same thumbnail URL still identifies the character, so it is updated instead of duplicated.
 */
export const buildCharacterMatcher = (characters, fileSearchNames) => {
  const bySearchName = new Map(characters.map((c) => [c.search_name, c]));
  const byThumbnail = new Map();
  for (const c of characters) {
    const url = c.source_images?.thumbnail;
    if (!url) continue;
    // A thumbnail shared by two characters cannot identify either of them
    byThumbnail.set(url, byThumbnail.has(url) ? null : c);
  }
  const claimed = new Set();

  return (mapped) => {
    const direct = bySearchName.get(mapped.searchName);
    if (direct) return { character: direct, renamed: false };
    const url = mapped.data.source_images.thumbnail;
    const byUrl = url ? byThumbnail.get(url) : null;
    // Only take over a character whose own name is gone from the file, and only once
    if (byUrl && !fileSearchNames.has(byUrl.search_name) && !claimed.has(byUrl._id.toString())) {
      claimed.add(byUrl._id.toString());
      return { character: byUrl, renamed: true };
    }
    return { character: null, renamed: false };
  };
};
