/**
 * Synchronisation des personnages depuis la master DB décryptée du jeu (SFTP)
 * et relais des images brutes (rmfs) vers le bucket FTP.
 *
 * Complète syncCharactersFromSFTP (characterSync.js) : ce module ne gère que les
 * champs dérivables des données brutes du jeu (nom réel, stats, affinité,
 * killers/catégories, soul traits, images, attack_type). attack_type n'est
 * dérivable que pour une partie des persos (couleur d'attaque absente pour ~la
 * moitié des lignes m_character_attack) : il n'est donc écrit que quand une
 * vraie valeur est trouvée, jamais écrasé par null. Les autres champs curés à
 * la main (banner, is_nad, is_sad, cancel_resistance, immunities, version,
 * version_name) ne sont jamais touchés par ce module.
 */
import { parse } from 'csv-parse/sync';
import { SFTPClient } from '../utils/database.js';
import { FTPUploader } from '../utils/ftp.js';
import { notifyDiscord } from '../utils/notifyDiscord.js';
import { buildSftpConfig } from '../utils/sftpConfig.js';

const GAME_DATA_BASE_PATH = () => process.env.SFTP_GAME_DATA_PATH || '/game_data';

// Doit correspondre aux clés attendues par affinitySlugMap côté front
// (schrift/src/utils/characterIcons.ts), pas aux slugs anglais.
const ELEMENT_MAP = {
  '1': 'Force',
  '2': 'Vitesse',
  '3': 'Technique',
  '4': 'Connaissance',
  '5': 'Instinct'
};

// Traduction de la race/faction de base (killer_type sans le suffixe _plus).
// killer_type1/2 = catégorie contre laquelle ce perso a un bonus de dégâts
// ("killer"). Le suffixe _plus correspond au "+" du style curé existant
// (ex: "Capitaine +").
const KILLER_BASE_MAP = {
  captain: 'Capitaine',
  espadas: 'Espada',
  hollow: 'Hollow',
  arrancar: 'Arrancar',
  soul_reaper: 'Shinigami',
  human: 'Humain',
  quincy: 'Quincy',
  stern_ritter: 'Stern Ritter',
  squad_zero: 'Division 0',
  // "Aucun" (pas "Neutre") : correspond à la clé réellement utilisée par
  // killerSlugMap/categorySlugMap côté front (schrift/src/utils/characterIcons.ts).
  neutral: 'Aucun'
};

const translateKillerType = (type) => {
  if (!type) return null;
  const isPlus = type.endsWith('_plus');
  const base = KILLER_BASE_MAP[isPlus ? type.slice(0, -5) : type];
  if (!base) return null;
  return isPlus ? `${base} +` : base;
};

// categories = ce que le perso EST (race + rang), via m_resource_3d.belong_type_1/2
// (résolu depuis resource_3d_id). Différent de killers (= contre quoi le perso a un
// bonus de dégâts, via killer_type1/2) même si le vocabulaire de traduction est partagé.
const deriveCategories = (row, resourcesById) => {
  const resource = resourcesById.get(row.resource_3d_id);
  if (!resource) return [];
  return [...new Set(
    [resource.belong_type_1, resource.belong_type_2]
      .map((type) => KILLER_BASE_MAP[type])
      .filter(Boolean)
  )];
};

const IMAGE_TYPES = ['thumb', 'stand', 'stand_gacha'];

const connectSftp = async () => {
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
  const sftpClient = new SFTPClient();
  await sftpClient.connect(sftpConfig);
  return sftpClient;
};

const downloadCsv = async (sftpClient, remotePath) => {
  const buffer = await sftpClient.client.get(remotePath);
  return parse(buffer.toString('utf8'), { columns: true, skip_empty_lines: true, relax_column_count: true });
};

const buildDictionary = (dictionaryRows) => {
  const map = new Map();
  for (const row of dictionaryRows) {
    const text = row.content_fr || row.content_en || row.content_ja || null;
    if (row.dictkey && text) map.set(row.dictkey, text);
  }
  return map;
};

const cleanKeyFallback = (key) => {
  if (!key) return null;
  return key.replace(/^lb_cname_chr_/, '').replace(/_full$/, '').replace(/_/g, ' ').trim();
};

const resolveDictText = (dictionary, key) => {
  if (!key) return null;
  return dictionary.get(key) || cleanKeyFallback(key);
};

const normalizeSearchName = (name) => (name || '').replace(/[^\w\sàâäéèêëïîôöùûüÿç]/gi, '').trim();

const formatAbility = (row, dictionary) => {
  const text = resolveDictText(dictionary, row.description) || row.type;
  if (!text) return null;
  const value = parseFloat(row.view_parameter);
  if (row.format === 'percent' && !isNaN(value) && value !== 0) return `${text} (+${value}%)`;
  if (row.format === 'interval' && !isNaN(value) && value !== 0) return `${text} (${value}ms)`;
  return text;
};

const formatExtraAbility = (row, dictionary) => {
  if (!row?.type) return null;
  const candidates = [`lb_${row.type}_detail`, `lb_${row.type.replace(/^ex_/, '')}_detail`, `lb_${row.type}`];
  for (const key of candidates) {
    const text = dictionary.get(key);
    if (text) return text;
  }
  return row.type;
};

// attack_type (R/B) = couleur des attaques du perso (mécanique de Nullification).
// Dérivé de m_character_attack.atk_color ('red'/'blue'), 6e colonne du CSV.
// Toutes les attaques n'ont pas de couleur définie (~moitié des lignes vides) :
// on prend la première trouvée en parcourant les groupes d'attaque par ordre
// de priorité (normal > heavy1-3 > ex > extra_action).
const ATTACK_GROUP_FIELDS = [
  'm_character_attack_group_id_normal',
  'm_character_attack_group_id_heavy1',
  'm_character_attack_group_id_heavy2',
  'm_character_attack_group_id_heavy3',
  'm_character_attack_group_id_ex',
  'm_character_attack_group_id_extra_action'
];

const ATK_COLOR_MAP = { red: 'R', blue: 'B' };

const deriveAttackType = (row, attacksByGroup) => {
  for (const field of ATTACK_GROUP_FIELDS) {
    const gid = row[field];
    if (!gid) continue;
    for (const attack of attacksByGroup.get(gid) || []) {
      const mapped = ATK_COLOR_MAP[attack.atk_color];
      if (mapped) return mapped;
    }
  }
  return null;
};

const formatGameDate = (rawDate) => {
  if (!rawDate) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(rawDate);
  if (!match) return null;
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
};

const buildAutoCharacterData = (row, dictionary, passiveAbilitiesByGroup, extraAbilityById, attacksByGroup, resourcesById) => {
  const name = resolveDictText(dictionary, row.full_name) || resolveDictText(dictionary, row.name);
  const searchName = normalizeSearchName(resolveDictText(dictionary, row.name) || name);

  const killers = [row.killer_type1, row.killer_type2]
    .map(translateKillerType)
    .filter(Boolean);

  const categories = deriveCategories(row, resourcesById);

  const soulTraits = (passiveAbilitiesByGroup.get(row.m_passive_ability_group_id) || [])
    .map((ability) => formatAbility(ability, dictionary))
    .filter(Boolean);

  const exSoulTraits = [row.m_extra_ability_id1, row.m_extra_ability_id2]
    .filter(Boolean)
    .map((id) => formatExtraAbility(extraAbilityById.get(id), dictionary))
    .filter(Boolean);

  return {
    game_id: Number(row.id),
    name: name || `Personnage ${row.id}`,
    search_name: searchName || `Personnage ${row.id}`,
    affinity: ELEMENT_MAP[row.character_element] || null,
    rarity: '6★',
    categories,
    killers,
    soul_traits: soulTraits,
    ex_soul_traits: exSoulTraits,
    stats: {
      end: row.third_max_hp || null,
      atk: row.third_max_atk || null,
      def: row.third_max_def || null,
      cct: row.third_max_crt || null,
      pre: row.third_max_sp || null
    },
    release_date: formatGameDate(row.start_date),
    resource_2d_id: row.resource_2d_id || null,
    attack_type: deriveAttackType(row, attacksByGroup),
    updated_at: new Date()
  };
};

const slugify = (text) => (text || '')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .toLowerCase()
  .replace(/\+/g, '-plus')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const REGISTRY_COLLECTIONS = [
  { collection: 'killers', field: 'killers' },
  { collection: 'categories', field: 'categories' },
  { collection: 'soul_traits', field: 'soul_traits' },
  { collection: 'ex_soul_traits', field: 'ex_soul_traits' }
];

// Recalcule les collections registres (valeurs distinctes + nombre de personnages)
// à partir des tableaux embarqués de `characters`. Additif uniquement : une
// valeur qui disparaîtrait des personnages n'est pas supprimée du registre.
export const syncRegistryCollections = async (db) => {
  const stats = {};
  for (const { collection, field } of REGISTRY_COLLECTIONS) {
    const rows = await db.collection('characters').aggregate([
      { $unwind: `$${field}` },
      { $match: { [field]: { $nin: [null, ''] } } },
      { $group: { _id: `$${field}`, character_count: { $sum: 1 } } }
    ]).toArray();

    if (rows.length === 0) { stats[collection] = 0; continue; }

    const ops = rows.map(({ _id: name, character_count }) => ({
      updateOne: {
        filter: { slug: slugify(name) },
        update: { $set: { slug: slugify(name), name, character_count, updated_at: new Date() } },
        upsert: true
      }
    }));
    await db.collection(collection).bulkWrite(ops, { ordered: false });
    stats[collection] = rows.length;
  }
  return stats;
};

const AUTO_FIELDS = ['name', 'search_name', 'affinity', 'rarity', 'categories', 'killers', 'soul_traits', 'ex_soul_traits', 'stats', 'release_date', 'resource_2d_id'];

const hasAutoFieldChanges = (existing, incoming) => {
  const baseChanged = AUTO_FIELDS.some((field) => JSON.stringify(existing?.[field] ?? null) !== JSON.stringify(incoming[field] ?? null));
  // attack_type n'est pas dans AUTO_FIELDS : on ne le compare/écrase que quand
  // on a une vraie valeur dérivée (jamais un écrasement par null d'une valeur curée).
  const attackTypeChanged = Boolean(incoming.attack_type) && incoming.attack_type !== existing?.attack_type;
  return baseChanged || attackTypeChanged;
};

export const syncCharactersFromGameDB = async (db) => {
  const basePath = GAME_DATA_BASE_PATH();
  let sftpClient;
  let characterRows, dictionaryRows, passiveAbilityRows, extraAbilityRows, characterAttackRows, resource3dRows;
  try {
    sftpClient = await connectSftp();
    [characterRows, dictionaryRows, passiveAbilityRows, extraAbilityRows, characterAttackRows, resource3dRows] = await Promise.all([
      downloadCsv(sftpClient, `${basePath}/db/m_character.csv`),
      downloadCsv(sftpClient, `${basePath}/db/m_dictionary.csv`),
      downloadCsv(sftpClient, `${basePath}/db/m_passive_ability.csv`),
      downloadCsv(sftpClient, `${basePath}/db/m_extra_ability.csv`),
      downloadCsv(sftpClient, `${basePath}/db/m_character_attack.csv`),
      downloadCsv(sftpClient, `${basePath}/db/m_resource_3d.csv`)
    ]);
  } catch (sftpErr) {
    const err = new Error('Erreur lors de la récupération de la master DB sur SFTP: ' + sftpErr.message);
    err.statusCode = 500;
    throw err;
  } finally {
    if (sftpClient) {
      try { await sftpClient.disconnect(); } catch { /* ignore */ }
    }
  }

  const dictionary = buildDictionary(dictionaryRows);

  const passiveAbilitiesByGroup = new Map();
  for (const row of passiveAbilityRows) {
    if (!row.group_id) continue;
    if (!passiveAbilitiesByGroup.has(row.group_id)) passiveAbilitiesByGroup.set(row.group_id, []);
    passiveAbilitiesByGroup.get(row.group_id).push(row);
  }
  for (const rows of passiveAbilitiesByGroup.values()) {
    rows.sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0));
  }

  const extraAbilityById = new Map(extraAbilityRows.map((row) => [row.id, row]));

  const attacksByGroup = new Map();
  for (const row of characterAttackRows) {
    if (!row.group_id) continue;
    if (!attacksByGroup.has(row.group_id)) attacksByGroup.set(row.group_id, []);
    attacksByGroup.get(row.group_id).push(row);
  }

  const resourcesById = new Map(resource3dRows.map((row) => [row.id, row]));

  const sixStarRows = characterRows.filter((row) => row.rarity === '6');

  let insertedCount = 0, updatedCount = 0, skippedCount = 0, needsCurationCount = 0;
  const errors = [];

  for (const row of sixStarRows) {
    try {
      const autoData = buildAutoCharacterData(row, dictionary, passiveAbilitiesByGroup, extraAbilityById, attacksByGroup, resourcesById);

      let existing = await db.collection('characters').findOne({ game_id: autoData.game_id });
      if (!existing && autoData.search_name) {
        existing = await db.collection('characters').findOne({ search_name: autoData.search_name });
      }

      if (existing) {
        if (hasAutoFieldChanges(existing, autoData)) {
          const updateData = { ...autoData };
          // Ne jamais écraser un attack_type curé par null quand la donnée jeu est absente.
          if (!updateData.attack_type) delete updateData.attack_type;
          await db.collection('characters').updateOne({ _id: existing._id }, { $set: updateData });
          updatedCount++;
        } else {
          skippedCount++;
        }
      } else {
        const newCharacter = {
          ...autoData,
          banner: { name: null, portal: null, url: null, banner_id: null },
          is_nad: false,
          is_sad: false,
          cancel_resistance: null,
          immunities: [],
          version: null,
          version_name: null,
          images: { thumbnail: null, artwork: null, attack: null, quote: null },
          needs_curation: true,
          created_at: new Date()
        };
        await db.collection('characters').insertOne(newCharacter);
        insertedCount++;
        needsCurationCount++;
      }
    } catch (charErr) {
      errors.push({ game_id: row.id, character: row.full_name || row.name, error: charErr.message });
      skippedCount++;
    }
  }

  const registryStats = await syncRegistryCollections(db);

  const message = `Synchronisation DB du jeu terminée: ${insertedCount} personnages créés (dont ${needsCurationCount} à curer), ${updatedCount} mis à jour, ${skippedCount} inchangés`;
  const statistics = {
    totalProcessed: sixStarRows.length,
    inserted: insertedCount,
    updated: updatedCount,
    skipped: skippedCount,
    needsCuration: needsCurationCount,
    errors: errors.length,
    registries: registryStats
  };

  notifyDiscord('character_update', { message, statistics });

  return { message, statistics, errors: errors.slice(0, 10) };
};

export const uploadGameDbImagesBatch = async (db, batchSize = 50) => {
  batchSize = Math.min(parseInt(batchSize) || 50, 100);
  const basePath = GAME_DATA_BASE_PATH();

  const characters = await db.collection('characters')
    .find({ resource_2d_id: { $exists: true, $ne: null }, images_from_game_db_uploaded: { $ne: true } })
    .limit(batchSize)
    .toArray();

  if (characters.length === 0) {
    const remaining = await db.collection('characters').countDocuments({ resource_2d_id: { $exists: true, $ne: null }, images_from_game_db_uploaded: { $ne: true } });
    return { message: 'Toutes les images de la DB du jeu sont déjà uploadées', statistics: { processed: 0, uploaded: 0, remaining, errors: 0 }, errors: [] };
  }

  let sftpClient, ftpUploader;
  try {
    sftpClient = await connectSftp();
    ftpUploader = new FTPUploader();
    await ftpUploader.connect();
  } catch (connErr) {
    if (sftpClient) { try { await sftpClient.disconnect(); } catch { /* ignore */ } }
    const err = new Error('Impossible de se connecter au SFTP/FTP: ' + connErr.message);
    err.statusCode = 500;
    throw err;
  }

  let uploaded = 0, processed = 0;
  const errors = [];

  for (const char of characters) {
    try {
      const gameImages = {};
      let hadRealError = false;
      for (const type of IMAGE_TYPES) {
        // Clé = _id Mongo (pas game_id) : le front construit l'URL des images
        // à la volée via `${bucketUrl}/characters/thumb/${character._id}.png`
        // (CharactersTable.tsx), même convention que l'ancien flux curé.
        const ftpPath = `/bucket.bbs-schrift.fr/characters/${type}/${char._id}.png`;
        const publicUrl = `https://bucket.bbs-schrift.fr/characters/${type}/${char._id}.png`;

        if (await ftpUploader.fileExists(ftpPath)) {
          gameImages[type] = publicUrl;
          continue;
        }

        try {
          const buffer = await sftpClient.client.get(`${basePath}/rmfs/Characters/${char.resource_2d_id}/${type}.png`);
          if (await ftpUploader.uploadBuffer(buffer, ftpPath)) {
            gameImages[type] = publicUrl;
            uploaded++;
          } else {
            hadRealError = true;
          }
        } catch (imgErr) {
          // Fichier absent côté source pour ce type d'image (ex: pas de stand_gacha) : on ignore.
          // Toute autre erreur (SFTP/FTP indisponible...) ne doit pas être traitée comme
          // "terminé" pour ce perso, sinon il ne sera plus jamais retenté.
          if (!/no such file/i.test(imgErr.message || '')) hadRealError = true;
        }
      }

      const setFields = { game_images: gameImages };
      if (!hadRealError) setFields.images_from_game_db_uploaded = true;
      if (!char.images?.thumbnail && gameImages.thumb) setFields['images.thumbnail'] = gameImages.thumb;
      if (!char.images?.artwork && gameImages.stand) setFields['images.artwork'] = gameImages.stand;

      await db.collection('characters').updateOne({ _id: char._id }, { $set: setFields });
      processed++;
      if (hadRealError) errors.push({ character: char.search_name || char.name, error: 'Upload incomplet, sera retenté' });
    } catch (charErr) {
      errors.push({ character: char.search_name || char.name, error: charErr.message });
    }
  }

  try { await sftpClient.disconnect(); } catch { /* ignore */ }
  try { await ftpUploader.disconnect(); } catch { /* ignore */ }

  const remaining = await db.collection('characters').countDocuments({ resource_2d_id: { $exists: true, $ne: null }, images_from_game_db_uploaded: { $ne: true } });
  const message = `Batch DB du jeu terminé: ${uploaded} images uploadées pour ${processed} personnages, ${remaining} restants`;
  const statistics = { processed, uploaded, remaining, errors: errors.length };

  notifyDiscord('image_upload', { message, statistics });

  return { message, statistics, errors: errors.slice(0, 10) };
};
