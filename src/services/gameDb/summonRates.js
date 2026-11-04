/**
 * Rate page of a summon: its new and selection units, and its rates. The tables only hold the units of
 * the summon layout, the page lists them all. As for the news, a page is fetched once then archived on
 * the FTP outside the public bucket. It is read in French, and exists for most summons but not all of them.
 * A character ticket whose page gives the rates only takes its units from the thumbnails of its news.
 */
import { AFFINITIES } from './buildCharacters.js';
import { PRIMARY_LANGUAGE } from './source.js';
import { fetchWithTimeout, gameNewsUrl, readSummonNews } from './summonNews.js';

const RATES_FTP_PATH = () => process.env.GAME_RATES_FTP_PATH || '/game-rates';
const RATE_TABLE = 'gacha-rate-rarity-table';
const UNIT_TABLE = 'gacha-rate-character-table';
const CHARACTER_TICKET = 'character_ticket';
// Raised when the reading changes: tickets read before without any unit are read once more
export const RATES_REVISION = 2;
// Units of the news: 6★ ids, or the 5★ id of the same unit
const SIX_STAR_OFFSET = 60000;
// A summon missing its page may get it soon after the start: it is tried again for that long
const RETRY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// Pages fetched from the source take longer than archived ones: a batch stops in time for the function
const BATCH_LIMIT = 100;
const BATCH_TIME_MS = 60000;

const cleanText = (html) => (html ?? '')
  .replace(/<\/?sup>/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const normalize = (text) => (text ?? '').trim().toLowerCase();

export const ratesArchivePath = (groupId, language = PRIMARY_LANGUAGE) => `${RATES_FTP_PATH()}/${language}/${groupId}.html`;

const isCharacterTicket = (banner) => banner.list_category === CHARACTER_TICKET;

// Page addresses to try: units of a group first, then those of a ticket draw, then the rates of the main draw
export const ratePagePaths = (banner) => {
  const mainGacha = banner.details?.main_gacha_id;
  return [
    ...(banner.list_category?.startsWith('accessory') ? [] : [`gacha_rate/character_gacha_rate?gacha_group_id=${banner.gacha_group_id}`]),
    ...(mainGacha && isCharacterTicket(banner) ? [`gacha_rate/beginner_pack?gacha_id=${mainGacha}`] : []),
    ...(mainGacha ? [`gacha_rate/index?gacha_id=${mainGacha}`] : []),
  ];
};

const isRatePage = (html) => html.includes(RATE_TABLE);
const hasUnits = (html) => html.includes(UNIT_TABLE);

const readArchive = async (ftp, path) => {
  try {
    return (await ftp.downloadBuffer(path)).toString('utf8');
  } catch (err) {
    if (err.status !== 404) throw err;
    return null;
  }
};

// Rate page from the FTP archive, fetched and archived when it is not there yet; null when it does not
// exist (the source then answers with its home page). A character ticket wants a page listing its units:
// an archived page without them is replaced by one that has them.
export const readSummonRates = async (ftp, banner) => {
  const path = ratesArchivePath(banner.gacha_group_id);
  const archived = await readArchive(ftp, path);
  const wantsUnits = isCharacterTicket(banner);
  if (archived && (!wantsUnits || hasUnits(archived))) return archived;
  let ratesOnly = null;
  for (const pagePath of ratePagePaths(banner)) {
    const html = await (await fetchWithTimeout(gameNewsUrl(pagePath))).text();
    if (!isRatePage(html)) continue;
    if (!wantsUnits || hasUnits(html)) {
      await ftp.uploadBuffer(Buffer.from(html, 'utf8'), path);
      return html;
    }
    ratesOnly ??= html;
  }
  if (archived) return archived;
  if (ratesOnly) await ftp.uploadBuffer(Buffer.from(ratesOnly, 'utf8'), path);
  return ratesOnly;
};

const sectionKind = (title) => {
  const text = title.toLowerCase();
  if (text.includes('disponibles')) return 'available';
  return text.includes('nouveaux') ? 'new' : 'selection';
};

const parseUnits = (table) => [...table.matchAll(/<td>([^<]*)<\/td>\s*<td>(\d)★<\/td>\s*<td class="element"><img[^>]*attribute-(\d)[^>]*><\/td>\s*<td>(.*?)<\/td>/gs)]
  .map(([, name, rarity, element, version]) => ({
    name: cleanText(name),
    rarity: Number(rarity),
    affinity: AFFINITIES[element] ?? null,
    version: cleanText(version) || null,
  }));

// Rate tables as they are shown: rows of cells, each cell being its lines of text
const parseRateTables = (html) => [...html.matchAll(/(?:<h4>([^<]*)<\/h4>\s*)?<table class="gacha-rate-rarity-table">(.*?)<\/table>/gs)]
  .map(([, title, table]) => ({
    title: cleanText(title) || null,
    rows: [...table.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map(([, row]) => ({
      header: !row.includes('<td'),
      cells: [...row.matchAll(/<t[dh][^>]*>(.*?)<\/t[dh]>/gs)].map(([, cell]) => cell.split(/<br\s*\/?>/).map(cleanText).filter(Boolean)),
    })),
  }));

export const parseSummonRates = (html) => {
  const sections = [...html.matchAll(/<section>(.*?)<\/section>/gs)].flatMap(([, section]) => {
    const match = /<h3[^>]*>([^<]*)<\/h3>\s*<table class="gacha-rate-character-table">(.*)/s.exec(section);
    return match ? [{ kind: sectionKind(cleanText(match[1])), units: parseUnits(match[2]) }] : [];
  });
  return { sections, tables: parseRateTables(html) };
};

// Site release date (dd/mm/yyyy) as a date
const releaseDate = (text) => {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(text ?? '');
  return match ? new Date(`${match[3]}-${match[2]}-${match[1]}T00:00:00Z`) : null;
};

// The page names units by short name, version and affinity: sheets matching a unit, several in rare cases
const createUnitIndex = (characters) => {
  const sheets = new Map();
  for (const character of characters) {
    const key = [character.short_names?.fr, character.game_version?.fr, character.affinity].map(normalize).join('|');
    sheets.set(key, [...(sheets.get(key) ?? []), character]);
  }
  return (unit) => sheets.get([unit.name, unit.version, unit.affinity].map(normalize).join('|')) ?? [];
};

const NEWS_CHARACTER = /\/Characters\/(\d+)\//g;

export const newsCharacterIds = (html) => new Set([...(html ?? '').matchAll(NEWS_CHARACTER)].map((match) => Number(match[1])));

// Sheets sharing a unit's identity: the one the summon news shows decides, then the only one already
// released; otherwise no link is better than a wrong one
const pickSheet = (candidates, shownIds, startedAt) => {
  const shown = candidates.filter((c) => shownIds.has(c.game_id));
  if (shown.length === 1) return shown[0];
  const released = candidates.filter((c) => startedAt && releaseDate(c.release_date) && releaseDate(c.release_date) <= startedAt);
  return released.length === 1 ? released[0] : null;
};

// Units shown on the news of a ticket, for a ticket whose rate page does not list them
const newsUnits = (html, sheetByGameId) => {
  const units = new Map();
  for (const id of newsCharacterIds(html)) {
    const sheet = sheetByGameId.get(id) ?? sheetByGameId.get(id + SIX_STAR_OFFSET);
    if (!sheet || units.has(sheet.game_id)) continue;
    units.set(sheet.game_id, {
      name: sheet.short_names?.fr ?? null,
      rarity: id >= SIX_STAR_OFFSET ? 6 : 5,
      affinity: sheet.affinity ?? null,
      version: sheet.game_version?.fr ?? null,
      game_id: sheet.game_id,
    });
  }
  return [...units.values()];
};

const unitCount = (rates) => (rates?.sections ?? []).reduce((sum, section) => sum + section.units.length, 0);

// A character ticket listing no unit falls back to those of its news, then counts as read from it
const withNewsUnits = async (ftp, banner, rates, sheetByGameId) => {
  const newsId = banner.details?.news_id;
  if (!isCharacterTicket(banner) || unitCount(rates) > 0 || !newsId) return null;
  const units = newsUnits(await readSummonNews(ftp, newsId).catch(() => null), sheetByGameId);
  if (units.length === 0) return null;
  return {
    sections: [{ kind: 'available', units }],
    available_count: units.length,
    tables: rates?.tables ?? [],
    source: 'news',
  };
};

const toStoredRates = async (ftp, banner, html, sheetsOf) => {
  const { sections, tables } = parseSummonRates(html);
  // Nearly the same on every summon, so only a ticket without selection keeps it: it is what it can give
  const hasSelection = sections.some((section) => section.kind !== 'available');
  const isTicket = banner.list_category?.endsWith('_ticket');
  const kept = sections.filter((section) => section.kind !== 'available' || (isTicket && !hasSelection));
  const ambiguous = kept.some((section) => section.units.some((unit) => sheetsOf(unit).length > 1));
  const newsId = banner.details?.news_id;
  const shownIds = ambiguous && newsId ? newsCharacterIds(await readSummonNews(ftp, newsId).catch(() => null)) : new Set();
  const startedAt = banner.started_at ? new Date(banner.started_at) : null;
  const sheetOf = (unit) => {
    const candidates = sheetsOf(unit);
    return candidates.length > 1 ? pickSheet(candidates, shownIds, startedAt) : candidates[0] ?? null;
  };
  return {
    sections: kept.map(({ kind, units }) => ({ kind, units: units.map((unit) => ({ ...unit, game_id: sheetOf(unit)?.game_id ?? null })) })),
    available_count: sections.find((section) => section.kind === 'available')?.units.length ?? 0,
    tables,
  };
};

const pendingFilter = { rates_pending: true };

export const pendingSummonRates = (db) => db.collection('banners').countDocuments(pendingFilter);

// Summons whose page is still to read: those never tried, upcoming ones included since their page comes
// out ahead of them, those without a page that are upcoming or recently started, and character tickets
// left without any unit by an older reading
export const queueSummonRates = async (db, now = new Date()) => {
  const retrySince = new Date(now.getTime() - RETRY_DAYS * DAY_MS);
  const { modifiedCount } = await db.collection('banners').updateMany(
    {
      list_category: { $exists: true },
      started_at: { $ne: null },
      $or: [
        { rates_status: { $exists: false } },
        { rates_status: 'missing', started_at: { $gte: retrySince } },
        { list_category: CHARACTER_TICKET, rates_revision: { $ne: RATES_REVISION }, 'rates.sections.units.0': { $exists: false } },
      ],
    },
    { $set: { rates_pending: true } }
  );
  return modifiedCount;
};

// Reads pending rate pages. A page that cannot be read counts as missing, so the upload loop always
// ends: queueSummonRates tries it again at a later sync while the summon is recent
export const archiveSummonRates = async (db, ftp, limit, now = Date.now) => {
  const deadline = now() + BATCH_TIME_MS;
  const pending = await db.collection('banners').find(pendingFilter).limit(Math.min(limit, BATCH_LIMIT)).toArray();
  if (pending.length === 0) return { archived: 0, processed: 0 };
  const characters = await db.collection('characters')
    .find({}, { projection: { game_id: 1, short_names: 1, game_version: 1, affinity: 1, release_date: 1 } })
    .toArray();
  const sheetsOf = createUnitIndex(characters);
  const sheetByGameId = new Map(characters.map((c) => [c.game_id, c]));
  let archived = 0;
  let processed = 0;
  for (const banner of pending) {
    if (now() > deadline) break;
    const html = await readSummonRates(ftp, banner).catch(() => null);
    const pageRates = html ? await toStoredRates(ftp, banner, html, sheetsOf) : null;
    const rates = (await withNewsUnits(ftp, banner, pageRates, sheetByGameId)) ?? pageRates;
    const update = rates ? { rates, rates_status: 'archived' } : { rates_status: 'missing' };
    await db.collection('banners').updateOne(
      { _id: banner._id },
      { $set: { ...update, rates_revision: RATES_REVISION, rates_checked_at: new Date() }, $unset: { rates_pending: '' } }
    );
    archived += rates ? 1 : 0;
    processed += 1;
  }
  return { archived, processed };
};
