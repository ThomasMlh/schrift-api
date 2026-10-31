/**
 * Fills the character file of the Discord bot (database.json on its SFTP) with the site data: bucket URLs
 * of the images, quote texts, id in the site database and game id. The file is edited in place, field by field: its
 * other rows, columns and number formats (4.0) stay byte for byte as they are.
 */
import { BOT_DATABASE_PATH, withSftp } from '../utils/sftp.js';
import { FTPUploader } from '../utils/ftp.js';
import { toSearchName } from './characterSource.js';

const BUCKET_URL = 'https://bucket.bbs-schrift.fr';
const BUCKET_ROOT = '/bucket.bbs-schrift.fr';
const PREVIEW_LIMIT = 100;

// File column -> bucket folders of the character image, first one present wins
const IMAGE_COLUMNS = [
  ['Link', ['thumb']],
  ['URL Artwork', ['artwork']],
  ['URL Phrase FR', ['phrase/fr']],
  ['URL Phrase EN', ['phrase/en']],
  ['URL ATK', ['attack']],
];
// File column -> language of the game quote text
const QUOTE_COLUMNS = [['Phrase FR', 'fr'], ['Phrase EN', 'en']];
const BUCKET_FOLDERS = [...new Set(IMAGE_COLUMNS.flatMap(([, folders]) => folders))];
export const BOT_FIELDS = [
  'Base ID', 'Game ID', 'Game Banner ID', ...IMAGE_COLUMNS.map(([column]) => column), 'URL Portail', ...QUOTE_COLUMNS.map(([column]) => column),
];

const normalizeName = (name) => String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const killersOf = (row) => new Set(String(row.Killers ?? [row['Killer 1'], row['Killer 2']].filter(Boolean).join(','))
  .split(',').map((k) => k.trim()).filter(Boolean));
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * Character of each row: by the ids written by a previous run, then the search name, then the name,
 * affinity and release date (killers and attack color to tell apart). A row nothing or several characters
 * match is left out, so nothing is ever written to the wrong row.
 */
export const matchBotRows = (rows, characters) => {
  const byId = new Map(characters.map((c) => [String(c._id), c]));
  const byGameId = new Map(characters.filter((c) => c.game_id).map((c) => [Number(c.game_id), c]));
  const bySearch = new Map();
  const byIdentity = new Map();
  for (const c of characters) {
    bySearch.set(c.search_name, [...(bySearch.get(c.search_name) ?? []), c]);
    const identity = `${normalizeName(c.name)}|${c.affinity}|${c.release_date}`;
    byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), c]);
  }

  const matches = [];
  const unresolved = [];
  const taken = new Map();
  rows.forEach((row, index) => {
    const label = row['Nom de recherche'] ?? row['Nom personnage'];
    if (!label) return;
    let character = byId.get(String(row['Base ID'] ?? '')) ?? byGameId.get(Number(row['Game ID']));
    let method = character ? 'id' : null;
    if (!character) {
      const found = bySearch.get(toSearchName(row['Nom de recherche'])) ?? [];
      if (found.length === 1) [character, method] = [found[0], 'search_name'];
    }
    if (!character) {
      let found = byIdentity.get(`${normalizeName(row['Nom personnage'])}|${row['Affinité']}|${row['Date sortie']}`) ?? [];
      if (found.length > 1) {
        const color = row['Attaques Rouges ou Bleues'] === 'Attaques B' ? 'B' : 'R';
        found = found.filter((c) => sameSet(new Set(c.killers ?? []), killersOf(row)) && c.attack_type === color);
      }
      if (found.length === 1) [character, method] = [found[0], 'identity'];
      else {
        unresolved.push({ index, label, reason: found.length === 0 ? 'none' : 'several' });
        return;
      }
    }
    const id = String(character._id);
    if (taken.has(id)) {
      unresolved.push({ index, label, reason: 'duplicate', other: taken.get(id) });
      return;
    }
    taken.set(id, label);
    matches.push({ index, label, character, method });
  });
  const missing = characters.filter((c) => !taken.has(String(c._id)));
  return { matches, unresolved, missing };
};

// Values of the bot columns for a character; only images present on the bucket and known texts are given
export const botFields = (character, { files, uploadedBanners }) => {
  const id = String(character._id);
  const fields = { 'Base ID': id, 'Game ID': character.game_id ?? null };
  for (const [column, folders] of IMAGE_COLUMNS) {
    const folder = folders.find((f) => files[f]?.has(`${id}.png`));
    if (folder) fields[column] = `${BUCKET_URL}/characters/${folder}/${id}.png`;
  }
  for (const [column, language] of QUOTE_COLUMNS) {
    if (character.quote?.[language]) fields[column] = character.quote[language];
  }
  // The summon the unit was released in; old ones are filed under group 0 in the game tables, not a summon id
  const summon = character.banners?.[0];
  if (summon?.gacha_group_id) fields['Game Banner ID'] = summon.gacha_group_id;
  if (summon && uploadedBanners.has(summon.gacha_group_id) && files.banners?.has(`gacha_${summon.gacha_group_id}.png`)) {
    fields['URL Portail'] = `${BUCKET_URL}/banners/gacha_${summon.gacha_group_id}.png`;
  }
  return fields;
};

// Spans [start, end) of the objects of the top-level array, read from the raw text
const objectSpans = (raw) => {
  const spans = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') {
      depth++;
      if (ch === '{' && depth === 2) start = i;
    } else if (ch === '}' || ch === ']') {
      if (ch === '}' && depth === 2) spans.push([start, i + 1]);
      depth--;
    }
  }
  return spans;
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PROPERTY_INDENT = ' '.repeat(8);

// Sets one property of a row object written with an indent of 4 (Python json.dumps), adding it at the end when missing
const setProperty = (text, key, value) => {
  const line = new RegExp(`\\n${PROPERTY_INDENT}${escapeRegExp(JSON.stringify(key))}: (.*?)(,?)(?=\\n)`);
  const serialized = JSON.stringify(value);
  if (line.test(text)) return text.replace(line, (_, __, comma) => `\n${PROPERTY_INDENT}${JSON.stringify(key)}: ${serialized}${comma}`);
  return text.replace(/\n {4}\}$/, `,\n${PROPERTY_INDENT}${JSON.stringify(key)}: ${serialized}\n    }`);
};

// edits: Map(row index -> { column: value }); the rest of the text is kept as it is
export const patchBotDatabase = (raw, edits) => {
  const spans = objectSpans(raw);
  let result = '';
  let cursor = 0;
  spans.forEach(([start, end], index) => {
    const changes = edits.get(index);
    if (!changes) return;
    let text = raw.slice(start, end);
    for (const [key, value] of Object.entries(changes)) text = setProperty(text, key, value);
    result += raw.slice(cursor, start) + text;
    cursor = end;
  });
  return result + raw.slice(cursor);
};

// Files of the bucket the URLs point to, listed once
const listBucket = async () => {
  const ftp = new FTPUploader();
  await ftp.connect();
  try {
    const files = {};
    for (const folder of BUCKET_FOLDERS) files[folder] = new Set((await ftp.client.list(`${BUCKET_ROOT}/characters/${folder}`)).map((f) => f.name));
    files.banners = new Set((await ftp.client.list(`${BUCKET_ROOT}/banners`)).map((f) => f.name));
    return files;
  } finally {
    await ftp.disconnect().catch(() => {});
  }
};

const downloadFile = (sftp) => sftp.get(BOT_DATABASE_PATH);

export const enrichBotDatabase = async (db, { dryRun = true } = {}) => {
  const [characters, banners, files] = await Promise.all([
    db.collection('characters').find({}, {
      projection: { name: 1, search_name: 1, game_id: 1, affinity: 1, release_date: 1, killers: 1, attack_type: 1, banners: 1, game_version: 1, quote: 1 },
    }).toArray(),
    db.collection('banners').find({ image_status: 'uploaded' }, { projection: { gacha_group_id: 1 } }).toArray(),
    listBucket(),
  ]);
  const uploadedBanners = new Set(banners.map((b) => b.gacha_group_id));

  return withSftp(async (sftp) => {
    const original = await downloadFile(sftp);
    const raw = original.toString('utf8');
    const rows = JSON.parse(raw);
    const { matches, unresolved, missing } = matchBotRows(rows, characters);

    const edits = new Map();
    const fieldCounts = Object.fromEntries(BOT_FIELDS.map((f) => [f, 0]));
    const updated = [];
    for (const { index, label, character, method } of matches) {
      const changes = Object.fromEntries(Object.entries(botFields(character, { files, uploadedBanners }))
        .filter(([field, value]) => rows[index][field] !== value));
      if (Object.keys(changes).length === 0) continue;
      edits.set(index, changes);
      for (const field of Object.keys(changes)) fieldCounts[field]++;
      updated.push({ label, method, fields: Object.keys(changes) });
    }

    const preview = {
      statistics: {
        rows: rows.filter((r) => r['Nom de recherche'] ?? r['Nom personnage']).length,
        matched: matches.length,
        matchedByIdentity: matches.filter((m) => m.method === 'identity').length,
        updated: updated.length,
        unresolved: unresolved.length,
        missing: missing.length,
      },
      fieldCounts,
      preview: {
        updated: updated.slice(0, PREVIEW_LIMIT),
        unresolved,
        missing: missing.map((c) => ({ _id: c._id, name: c.name, version: c.game_version?.fr ?? null })),
      },
    };
    if (dryRun || edits.size === 0) return { dryRun, ...preview };

    const patched = patchBotDatabase(raw, edits);
    // The patched text must read back as the file with exactly these changes
    const expected = rows.map((row, index) => ({ ...row, ...edits.get(index) }));
    if (JSON.stringify(JSON.parse(patched)) !== JSON.stringify(expected)) {
      throw Object.assign(new Error('Modification du fichier incohérente : rien n\'a été écrit'), { statusCode: 500 });
    }
    // Someone may have edited the file meanwhile: never overwrite their changes
    if (!(await downloadFile(sftp)).equals(original)) {
      throw Object.assign(new Error('database.json a été modifié pendant l\'opération : relancez la simulation'), { statusCode: 409 });
    }
    await sftp.put(Buffer.from(patched, 'utf8'), BOT_DATABASE_PATH);
    return { dryRun: false, ...preview };
  });
};
