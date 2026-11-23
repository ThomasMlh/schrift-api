/**
 * How a character is obtained, as players sort them (Premium, Seasonal, Exclusive...). The game stores no
 * such category: it is deduced from the Brave Souls tickets that can give the character, the exchange
 * shops and the summon it was released in. An admin can force another value on a character.
 */

export const ACQUISITIONS = [
  'premium', 'seasonal', 'seasonal_medal', 'exclusive', 'senkaimon', 'brave_battle', 'kan_shop', 'frenzy', 'exchange', 'mixer', 'misc',
];

// Tables read on top of the character and summon tables
export const ACQUISITION_TABLES = ['m_exchange_shop'];

// Exchange shops (m_exchange_shop.name) that give a category of their own
const SHOP_ACQUISITIONS = {
  lb_exchange_tower_medal_shop_name: 'senkaimon',
  lb_exchange_tower_rereleased_medal_shop_name: 'senkaimon',
  lb_exchange_rare_medal_shop_name: 'brave_battle',
  lb_exchange_coin_shop_name: 'kan_shop',
};
// Medals of the summons ("pity"): ignored, except its exchanges without an end date for units given nowhere else
const SUMMON_MEDAL_SHOP = 'lb_exchange_gacha_medal_shop_name';

// Brave Souls tickets; the Fest choice ticket also offers exclusive units
const BRAVE_SOULS_TICKET = /ticket/i;
const BRAVE_SOULS = /brave souls/i;
const NOT_BRAVE_SOULS_POOL = /accessoires|à choix spécial Brave Souls Fest/i;
// The memorial ticket only gives seasonal units
const MEMORIAL = /mémorial/i;
// Seasonal tickets (outside the Brave Souls ones): their units are seasonal ones out of the Brave Souls pool
const SEASONAL_TICKET = /saisonni/i;
// Words of the seasonal events, in a version or in the summon a unit was released in
const SEASONAL_WORDS = /saint-valentin|halloween|noël|nouvel an|white day|maillot|été|parapluie|society|the manor|saisonni/i;
// Summons that are not the release of a unit (tickets, passes)
const NOT_A_RELEASE = /ticket|passe/i;
// A unit is released by a summon starting a few days around its release date
const RELEASE_WINDOW_DAYS = { before: 3, after: 10 };
const SIX_STAR_OFFSET = 60000;

const baseId = (id) => Number(id) % SIX_STAR_OFFSET;
const DAY_MS = 24 * 60 * 60 * 1000;
// "dd/mm/yyyy" -> UTC time, null when unreadable
const parseDay = (value) => {
  const [day, month, year] = String(value ?? '').split('/').map(Number);
  return day && month && year ? Date.UTC(year, month - 1, day) : null;
};

// Units each exchange shop gives: shop category of a unit, and summon medal exchanges without an end date
export const buildExchanges = (tables, dict) => {
  const shops = new Map((tables.m_exchange_shop ?? []).map((row) => [row.id, row.name]));
  const categories = new Map((tables.m_exchange_shop_category ?? []).map((row) => [row.id, row]));
  const shop = new Map();
  const medal = new Map();
  for (const product of tables.m_exchange_shop_product ?? []) {
    if (product.content_type !== 'character') continue;
    const category = categories.get(product.exchange_shop_category_id);
    const shopName = category && shops.get(category.exchange_shop_id);
    if (!shopName) continue;
    const id = baseId(product.content_id);
    if (SHOP_ACQUISITIONS[shopName] && !shop.has(id)) shop.set(id, SHOP_ACQUISITIONS[shopName]);
    if (shopName === SUMMON_MEDAL_SHOP && !category.end_date && !medal.has(id)) medal.set(id, dict.text(category.name) ?? null);
  }
  return { shop, medal };
};

const bannerName = (banner) => banner.names?.fr ?? (typeof banner.name === 'string' ? banner.name : banner.name?.fr) ?? '';
const bannerUnits = (banner) => new Set([
  ...(banner.character_game_ids ?? []),
  ...(banner.rates?.sections ?? []).flatMap((section) => (section.units ?? []).map((unit) => unit.game_id)),
].filter(Boolean).map(baseId));

// Summons seen from the units: the Brave Souls tickets pool, the memorial ticket, every summon of a unit
export const indexBanners = (banners) => {
  const pool = new Set();
  const memorial = new Set();
  const seasonalTickets = new Set();
  const byUnit = new Map();
  for (const banner of banners) {
    const name = bannerName(banner);
    const units = bannerUnits(banner);
    const inPool = BRAVE_SOULS_TICKET.test(name) && BRAVE_SOULS.test(name) && !NOT_BRAVE_SOULS_POOL.test(name);
    const entry = { name, start: parseDay(banner.start_date) };
    for (const id of units) {
      if (inPool) pool.add(id);
      if (MEMORIAL.test(name)) memorial.add(id);
      if (BRAVE_SOULS_TICKET.test(name) && SEASONAL_TICKET.test(name)) seasonalTickets.add(id);
      if (!byUnit.has(id)) byUnit.set(id, []);
      byUnit.get(id).push(entry);
    }
  }
  return { pool, memorial, seasonalTickets, byUnit };
};

// Name of the summon a unit was released in, '' when unknown
const releaseSummon = (character, byUnit) => {
  const release = parseDay(character.release_date);
  if (release === null) return '';
  const candidates = (byUnit.get(baseId(character.game_id)) ?? [])
    .filter((b) => b.start !== null && !NOT_A_RELEASE.test(b.name)
      && b.start >= release - RELEASE_WINDOW_DAYS.before * DAY_MS && b.start <= release + RELEASE_WINDOW_DAYS.after * DAY_MS)
    .sort((a, b) => a.start - b.start);
  return candidates[0]?.name ?? '';
};

const versionOf = (character) => character.game_version?.fr ?? '';

// Seasonal versions: one in the memorial ticket, one named after an event, or one most of whose units
// were released in an event summon
export const seasonalVersions = (characters, { memorial, byUnit }) => {
  const byVersion = new Map();
  for (const character of characters) {
    const version = versionOf(character);
    if (!version || !character.game_id) continue;
    if (!byVersion.has(version)) byVersion.set(version, []);
    byVersion.get(version).push(character);
  }
  const seasonal = new Set();
  for (const [version, units] of byVersion) {
    const inEvents = units.filter((c) => SEASONAL_WORDS.test(releaseSummon(c, byUnit))).length;
    if (SEASONAL_WORDS.test(version) || units.some((c) => memorial.has(baseId(c.game_id))) || inEvents * 2 > units.length) seasonal.add(version);
  }
  return seasonal;
};

/**
 * Category of each character: { acquisition, acquisition_exchange } by game_id.
 * exchanges: buildExchanges(); banners: the summons of the site (names, units, start dates).
 */
export const computeAcquisitions = (characters, exchanges, banners) => {
  const index = indexBanners(banners);
  const seasonal = seasonalVersions(characters, index);
  const result = new Map();
  for (const character of characters) {
    if (!character.game_id) continue;
    const id = baseId(character.game_id);
    const inPool = index.pool.has(id);
    const isSeasonal = seasonal.has(versionOf(character));
    const exchangeOnly = !index.byUnit.has(id) && exchanges.medal.has(id);
    let acquisition;
    if (character.is_growth_event) acquisition = 'frenzy';
    else if (exchanges.shop.has(id)) acquisition = exchanges.shop.get(id);
    else if ((character.categories ?? []).includes('Stern Ritter')) acquisition = 'exclusive';
    else if (inPool) acquisition = isSeasonal ? 'seasonal' : 'premium';
    else if (exchangeOnly) acquisition = 'exchange';
    else if (isSeasonal && index.seasonalTickets.has(id)) acquisition = 'seasonal_medal';
    else acquisition = 'exclusive';
    result.set(character.game_id, {
      acquisition,
      acquisition_exchange: acquisition === 'exchange' ? exchanges.medal.get(id) : null,
    });
  }
  return result;
};

// Values of the old "rarity" field, entered by hand from the bot file
const LEGACY = {
  Premium: 'premium',
  Saisonnier: 'seasonal',
  Exclusive: 'exclusive',
  Senkaimon: 'senkaimon',
  'Echange Brave Battle': 'brave_battle',
  'Shop Kans': 'kan_shop',
  'Ticket Frenzy': 'frenzy',
  Divers: 'misc',
  'Loterie Mixeur': 'mixer',
};
const legacyAcquisition = (rarity) => {
  const value = String(rarity ?? '').trim();
  return LEGACY[value] ?? (/^Echange /.test(value) ? 'exchange' : null);
};

// The first time, an old hand-entered value that the computing does not find becomes the admin's choice,
// so nothing shown changes; characters without one, and new ones, follow the computing
export const legacyOverride = (character, computed) => {
  const legacy = legacyAcquisition(character.rarity);
  return legacy && legacy !== computed ? legacy : null;
};

// Updates of the characters whose category changed
export const acquisitionUpdates = (characters, computed) => characters.flatMap((character) => {
  const next = computed.get(character.game_id);
  if (!next) return [];
  const set = {};
  if (character.acquisition !== next.acquisition) set.acquisition = next.acquisition;
  if (JSON.stringify(character.acquisition_exchange ?? null) !== JSON.stringify(next.acquisition_exchange)) set.acquisition_exchange = next.acquisition_exchange;
  if (character.acquisition_override === undefined) set.acquisition_override = legacyOverride(character, next.acquisition);
  return Object.keys(set).length > 0 ? [{ _id: character._id, set }] : [];
});

// Computes the category of every character of the site and saves it, unless dryRun: returns the number of changes
export const saveAcquisitions = async (db, tables, dict, { dryRun = false } = {}) => {
  const characters = await db.collection('characters')
    .find({ game_id: { $ne: null } }, { projection: { game_id: 1, game_version: 1, release_date: 1, categories: 1, is_growth_event: 1, rarity: 1, acquisition: 1, acquisition_exchange: 1, acquisition_override: 1 } })
    .toArray();
  const banners = await db.collection('banners')
    .find({}, { projection: { name: 1, names: 1, start_date: 1, character_game_ids: 1, 'rates.sections.units.game_id': 1 } })
    .toArray();
  const updates = acquisitionUpdates(characters, computeAcquisitions(characters, buildExchanges(tables, dict), banners));
  if (!dryRun && updates.length > 0) {
    await db.collection('characters').bulkWrite(updates.map(({ _id, set }) => ({ updateOne: { filter: { _id }, update: { $set: set } } })), { ordered: false });
  }
  return updates.length;
};
