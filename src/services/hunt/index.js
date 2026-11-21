import { ObjectId } from 'mongodb';
import { findTokenUser, getEventById, guildSnapshot, isEventOpen, userKey } from '../quiz/index.js';
import { awardEventBadge, awardHunterBadge } from '../eventBadges.js';

// Gift hunt of an event: each day an admin hides a gift on one page of the site, with a hint shown on
// the event page. A logged-in player who opens that page that day sees the gift and picks it up. Each
// gift gives ranking points, raffle tickets for the month it was found in, and counts towards the
// community goal; finding enough of them gives the hunter badge.
// The page of the day never leaves the server: the site only asks whether the page shown hides it.

const DAY_MS = 24 * 3600 * 1000;
export const DEFAULT_HUNT = { enabled: false, points: 3, tickets: 1, badge_name: null, badge_min: 10 };

const error = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const spots = (db) => db.collection('hunt_spots');
export const huntFinds = (db) => db.collection('hunt_finds');

// One find per player and day, even with two clicks at once
const indexReady = new WeakMap();
const ensureFindIndex = (db) => {
  if (!indexReady.has(db)) {
    indexReady.set(db, huntFinds(db).createIndex({ event_id: 1, user_id: 1, day: 1 }, { unique: true }).catch((err) => {
      indexReady.delete(db);
      throw err;
    }));
  }
  return indexReady.get(db);
};

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(Math.max(min, Math.min(max, number))) : fallback;
};

export const sanitizeHunt = (input = {}) => ({
  enabled: Boolean(input?.enabled),
  points: clamp(input?.points, 0, 100, DEFAULT_HUNT.points),
  tickets: clamp(input?.tickets, 0, 5, DEFAULT_HUNT.tickets),
  badge_name: String(input?.badge_name ?? '').trim().slice(0, 60) || null,
  badge_min: clamp(input?.badge_min, 1, 31, DEFAULT_HUNT.badge_min),
});

export const huntOf = (event) => ({ ...DEFAULT_HUNT, ...(event?.hunt ?? {}) });

const dayCount = (event) => Math.min(31, Math.ceil((event.end_at - event.start_at) / DAY_MS));
const opensAt = (event, day) => new Date(event.start_at.getTime() + (day - 1) * DAY_MS);
// Day of the event a date falls in, from 1; null outside the event
export const dayOf = (event, now) => {
  if (!isEventOpen(event, now)) return null;
  const day = Math.floor((now - event.start_at) / DAY_MS) + 1;
  return day <= dayCount(event) ? day : null;
};

/** Site path in a comparable form: no query, no trailing slash, decoded, lower case. */
export const normalizePath = (value) => {
  let path = String(value ?? '').trim().split(/[?#]/)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep it encoded when it is not valid
  }
  path = `/${path.replace(/^\/+/, '').replace(/\/+$/, '')}`.toLowerCase();
  return path.slice(0, 200);
};

// ---------- Admin ----------

export const listSpots = async (db, eventId) => {
  const event = await getEventById(db, eventId);
  const [list, counts] = await Promise.all([
    spots(db).find({ event_id: eventId }).sort({ day: 1 }).toArray(),
    huntFinds(db).aggregate([{ $match: { event_id: eventId } }, { $group: { _id: '$day', finds: { $sum: 1 } } }]).toArray(),
  ]);
  const findsOf = new Map(counts.map((c) => [c._id, c.finds]));
  return {
    hunt: huntOf(event),
    days: dayCount(event),
    spots: list.map((s) => ({ ...s, opens_at: opensAt(event, s.day), finds: findsOf.get(s.day) ?? 0 })),
  };
};

export const saveSpot = async (db, eventId, day, input) => {
  const event = await getEventById(db, eventId);
  const number = Number(day);
  if (!Number.isInteger(number) || number < 1 || number > dayCount(event)) throw error(400, `Jour invalide (1 à ${dayCount(event)})`);
  const path = normalizePath(input?.path);
  if (path === '/' && !String(input?.path ?? '').trim()) throw error(400, 'Indique la page où cacher le cadeau');
  if (path.startsWith('/admin') || path.startsWith('/anniversaire')) throw error(400, 'Choisis une page visible par les joueurs, hors page de l\'événement');
  const hint = String(input?.hint ?? '').trim().slice(0, 200);
  if (!hint) throw error(400, 'Écris un indice');
  if (await huntFinds(db).countDocuments({ event_id: eventId, day: number })) {
    const previous = await spots(db).findOne({ event_id: eventId, day: number });
    if (previous && previous.path !== path) throw error(409, 'Des joueurs ont déjà trouvé ce cadeau : la page ne peut plus changer');
  }
  const doc = { event_id: eventId, day: number, path, hint, updated_at: new Date() };
  await spots(db).updateOne({ event_id: eventId, day: number }, { $set: doc }, { upsert: true });
  return spots(db).findOne({ event_id: eventId, day: number });
};

export const deleteSpot = async (db, eventId, day) => {
  const number = Number(day);
  if (await huntFinds(db).countDocuments({ event_id: eventId, day: number })) throw error(409, 'Des joueurs ont déjà trouvé ce cadeau');
  const { deletedCount } = await spots(db).deleteOne({ event_id: eventId, day: number });
  if (!deletedCount) throw error(404, 'Cachette introuvable');
};

const STATIC_PAGES = [
  ['/guildes', 'Là où l\'on présente les guildes'],
  ['/personnages', 'Dans la grande liste des persos'],
  ['/invocations', 'Du côté des invocations'],
  ['/cycles', 'Dans l\'historique des cycles'],
  ['/podium', 'Sur les marches du podium'],
  ['/comparateur', 'Là où l\'on compare deux joueurs'],
  ['/joueurs', 'Dans la liste des joueurs'],
  ['/guides', 'Entre les pages des guides'],
  ['/recrutement', 'Là où l\'on postule'],
];

const sample = async (collection, match, projection) => (await collection.aggregate([
  { $match: match }, { $sample: { size: 1 } }, { $project: projection },
]).toArray())[0] ?? null;

/** A page to suggest, with a starting hint: a player profile, a character sheet or a main page. */
export const randomSpot = async (db, eventId) => {
  const used = new Set((await spots(db).find({ event_id: eventId }, { projection: { path: 1 } }).toArray()).map((s) => s.path));
  for (let tries = 0; tries < 8; tries += 1) {
    const kind = ['player', 'character', 'static'][tries % 3 === 0 ? Math.floor(Math.random() * 3) : tries % 3];
    let suggestion = null;
    if (kind === 'player') {
      const user = await sample(db.collection('users'), { 'bbs_accounts.bbs_name': { $type: 'string' }, is_banned: { $ne: true } }, { bbs_accounts: 1 });
      const name = user?.bbs_accounts?.find((a) => a.bbs_name)?.bbs_name;
      if (name) suggestion = { path: `/joueur/${name}`, hint: `Sur le profil d'un joueur dont le nom commence par « ${name[0].toUpperCase()} »`, label: `Profil de ${name}` };
    } else if (kind === 'character') {
      const character = await sample(db.collection('characters'), { name: { $type: 'string' } }, { name: 1, version_name: 1 });
      if (character) {
        suggestion = {
          path: `/personnage/${character._id}`,
          hint: `Sur la fiche d'un perso dont le nom commence par « ${character.name[0].toUpperCase()} »`,
          label: `Fiche de ${character.name}${character.version_name ? ` (${character.version_name})` : ''}`,
        };
      }
    } else {
      const [path, hint] = STATIC_PAGES[Math.floor(Math.random() * STATIC_PAGES.length)];
      suggestion = { path, hint, label: path };
    }
    if (suggestion && !used.has(normalizePath(suggestion.path))) return { ...suggestion, path: normalizePath(suggestion.path) };
  }
  throw error(404, 'Aucune page disponible');
};

// ---------- Player ----------

/** What a player knows of the hunt: today's hint and their finds; never the page. */
export const huntView = async (db, event, token, now = new Date()) => {
  const hunt = huntOf(event);
  if (!hunt.enabled) return null;
  const eventId = event._id.toString();
  const day = dayOf(event, now);
  const spot = day ? await spots(db).findOne({ event_id: eventId, day }, { projection: { hint: 1 } }) : null;
  const key = userKey(token);
  const mine = key ? await huntFinds(db).find({ event_id: eventId, user_id: key }, { projection: { day: 1 } }).toArray() : [];
  return {
    points: hunt.points,
    tickets: hunt.tickets,
    badge_name: hunt.badge_name,
    badge_min: hunt.badge_min,
    days: dayCount(event),
    today: day,
    hint: spot?.hint ?? null,
    found_today: Boolean(day && mine.some((f) => f.day === day)),
    found: mine.length,
  };
};

// The open event whose hunt runs now
const runningHunt = async (db, now) => {
  const list = await db.collection('events').find({ 'hunt.enabled': true, start_at: { $lte: now }, end_at: { $gte: now } }).sort({ start_at: -1 }).toArray();
  return list[0] ?? null;
};

const todaySpot = async (db, event, now) => {
  const day = dayOf(event, now);
  return day ? spots(db).findOne({ event_id: event._id.toString(), day }) : null;
};

/** Whether the page the player is on hides today's gift, and whether they already picked it up. */
export const checkPage = async (db, token, path, now = new Date()) => {
  const event = await runningHunt(db, now);
  const spot = event ? await todaySpot(db, event, now) : null;
  if (!spot || spot.path !== normalizePath(path)) return { gift: false };
  const found = await huntFinds(db).findOne({ event_id: spot.event_id, user_id: userKey(token), day: spot.day }, { projection: { _id: 1 } });
  return { gift: !found, event_id: spot.event_id, day: spot.day };
};

/** Picks up today's gift from the page it hides on. */
export const claimGift = async (db, token, path, now = new Date()) => {
  const key = userKey(token);
  if (!key) throw error(401, 'Connexion requise');
  const event = await runningHunt(db, now);
  const spot = event ? await todaySpot(db, event, now) : null;
  if (!spot || spot.path !== normalizePath(path)) throw error(404, 'Pas de cadeau ici');

  const user = await findTokenUser(db, token);
  await ensureFindIndex(db);
  try {
    await huntFinds(db).insertOne({
      event_id: spot.event_id,
      day: spot.day,
      user_id: key,
      user_name: user?.global_name || user?.username || null,
      ...(await guildSnapshot(db, user)),
      found_at: now,
    });
  } catch (err) {
    if (err.code === 11000) throw error(409, 'Tu as déjà trouvé le cadeau du jour');
    throw err;
  }
  const hunt = huntOf(event);
  const found = await huntFinds(db).countDocuments({ event_id: spot.event_id, user_id: key });
  await awardEventBadge(db, event, key, 'hunt', now);
  const hunter = found >= hunt.badge_min ? await awardHunterBadge(db, event, key, now) : false;
  return { points: hunt.points, tickets: hunt.tickets, found, hunter_badge: hunter };
};

/** Raffle tickets earned with gifts by each bbs account between two dates. */
export const huntTicketsBetween = async (db, bbsIds, from, to) => {
  if (!bbsIds.length) return new Map();
  const finds = await huntFinds(db).find(
    { bbs_id: { $in: bbsIds }, found_at: { $gte: new Date(from), $lt: new Date(to) } },
    { projection: { bbs_id: 1, event_id: 1 } },
  ).toArray();
  if (!finds.length) return new Map();
  const eventIds = [...new Set(finds.map((f) => f.event_id))].filter(ObjectId.isValid);
  const events = await db.collection('events').find({ _id: { $in: eventIds.map((id) => new ObjectId(id)) } }, { projection: { hunt: 1 } }).toArray();
  const ticketsOf = new Map(events.map((e) => [e._id.toString(), huntOf(e).tickets]));
  const byAccount = new Map();
  for (const f of finds) byAccount.set(f.bbs_id, (byAccount.get(f.bbs_id) ?? 0) + (ticketsOf.get(f.event_id) ?? 0));
  return byAccount;
};

export const deleteEventHunt = async (db, eventId) => {
  await spots(db).deleteMany({ event_id: eventId });
  await huntFinds(db).deleteMany({ event_id: eventId });
};

export const huntHasFinds = async (db, eventId) => (await huntFinds(db).countDocuments({ event_id: eventId })) > 0;
