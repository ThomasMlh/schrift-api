import { ObjectId } from 'mongodb';
import { matchFreeText } from '../quiz/grading.js';
import { findTokenUser, getEventById, guildSnapshot, isEventOpen, isEventOver, userKey } from '../quiz/index.js';
import { awardEventBadge } from '../eventBadges.js';
import { CLUE_TYPES, removeClue, sanitizeClueSettings, storeClue } from './clues.js';
import { withPlayers } from '../quiz/players.js';

// Advent calendar of an event: one case a day from the event start, each hiding a character to name.
// Case N opens N-1 days after the start. Answered the day it opens it gives full points, later half.
// One answer per case; close answers wait for an admin. Answers are revealed when the event ends.

const DAY_MS = 24 * 3600 * 1000;
export const DEFAULT_ADVENT = { enabled: false, days: 24, points: 10 };
const LATE_RATIO = 0.5;

const error = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const cases = (db) => db.collection('advent_cases');
const answers = (db) => db.collection('advent_answers');

// One answer per player and case, even with two sends at once
const indexReady = new WeakMap();
const ensureAnswerIndex = (db) => {
  if (!indexReady.has(db)) {
    indexReady.set(db, answers(db).createIndex({ event_id: 1, user_id: 1, day: 1 }, { unique: true }).catch((err) => {
      indexReady.delete(db);
      throw err;
    }));
  }
  return indexReady.get(db);
};

export const sanitizeAdvent = (input = {}) => ({
  enabled: Boolean(input?.enabled),
  days: Math.round(Math.max(1, Math.min(31, Number(input?.days) || DEFAULT_ADVENT.days))),
  points: Math.max(1, Math.min(100, Number(input?.points) || DEFAULT_ADVENT.points)),
});

const adventOf = (event) => ({ ...DEFAULT_ADVENT, ...(event.advent ?? {}) });

// Days that fit in the event: a case cannot open after it ends
const dayCount = (event) => Math.min(adventOf(event).days, Math.ceil((event.end_at - event.start_at) / DAY_MS));
const opensAt = (event, day) => new Date(event.start_at.getTime() + (day - 1) * DAY_MS);

const textValues = (value) => (typeof value === 'string' ? [value] : Object.values(value ?? {}).filter((v) => typeof v === 'string'));

/** Names a player may give for a character: full and short names in every language, and their words. */
export const defaultAccepted = (character) => {
  const names = [character.name, ...textValues(character.names), ...textValues(character.short_names)]
    .map((n) => String(n ?? '').trim()).filter(Boolean);
  const words = names.flatMap((n) => n.split(/\s+/)).filter((w) => w.length >= 4);
  return [...new Set([...names, ...words])].slice(0, 20);
};

const characterOf = (db, id) => (ObjectId.isValid(id) ? db.collection('characters').findOne({ _id: new ObjectId(id) }) : null);

// ---------- Admin ----------

export const listCases = async (db, eventId) => {
  const event = await getEventById(db, eventId);
  const list = await cases(db).find({ event_id: eventId }).sort({ day: 1 }).toArray();
  const characters = await db.collection('characters')
    .find({ _id: { $in: list.map((c) => c.character_id).filter(ObjectId.isValid).map((id) => new ObjectId(id)) } }, { projection: { name: 1, version: 1, version_name: 1, images_version: 1 } })
    .toArray();
  const byId = new Map(characters.map((c) => [c._id.toString(), c]));
  const counts = await answers(db).aggregate([
    { $match: { event_id: eventId } },
    { $group: { _id: '$day', total: { $sum: 1 }, pending: { $sum: { $cond: [{ $and: [{ $eq: ['$status', 'pending'] }, { $not: ['$reviewed'] }] }, 1, 0] } } } },
  ]).toArray();
  const countOf = new Map(counts.map((c) => [c._id, c]));
  return {
    advent: adventOf(event),
    days: dayCount(event),
    cases: list.map((c) => ({
      ...c,
      character: byId.get(c.character_id) ?? null,
      opens_at: opensAt(event, c.day),
      answers: countOf.get(c.day)?.total ?? 0,
      pending: countOf.get(c.day)?.pending ?? 0,
    })),
  };
};

/** Creates or replaces the case of a day; the clue picture is drawn again when its settings change. */
export const saveCase = async (db, eventId, day, input) => {
  const event = await getEventById(db, eventId);
  const number = Number(day);
  if (!Number.isInteger(number) || number < 1 || number > dayCount(event)) throw error(400, `Jour invalide (1 à ${dayCount(event)})`);
  const character = await characterOf(db, input?.character_id);
  if (!character) throw error(400, 'Choisis un perso');
  const type = CLUE_TYPES.includes(input?.clue_type) ? input.clue_type : null;
  if (!type) throw error(400, 'Type d\'indice inconnu');
  const settings = sanitizeClueSettings(input?.settings);
  const clueText = type === 'quote' ? String(input?.clue_text ?? character.quote?.fr ?? character.quote ?? '').trim().slice(0, 500) : null;
  if (type === 'quote' && !clueText) throw error(400, 'Ce perso n\'a pas de citation : écris-en une ou choisis un autre indice');
  const accepted = (Array.isArray(input?.accepted) ? input.accepted : defaultAccepted(character))
    .map((a) => String(a ?? '').trim().slice(0, 80)).filter(Boolean);
  if (!accepted.length) throw error(400, 'Ajoute au moins une réponse acceptée');

  const previous = await cases(db).findOne({ event_id: eventId, day: number });
  const sameClue = previous && previous.clue_path && previous.character_id === character._id.toString() && previous.clue_type === type
    && JSON.stringify(previous.settings) === JSON.stringify(settings);
  const cluePath = type === 'quote' ? null
    : sameClue ? previous.clue_path
      : await storeClue(eventId, character.source_images?.artwork, type, settings);
  if (previous?.clue_path && previous.clue_path !== cluePath) await removeClue(previous.clue_path);

  const doc = {
    event_id: eventId, day: number, character_id: character._id.toString(), clue_type: type, settings,
    clue_path: cluePath, clue_text: clueText, accepted, updated_at: new Date(),
  };
  await cases(db).updateOne({ event_id: eventId, day: number }, { $set: doc }, { upsert: true });
  return cases(db).findOne({ event_id: eventId, day: number });
};

export const deleteCase = async (db, eventId, day) => {
  const number = Number(day);
  if (await answers(db).countDocuments({ event_id: eventId, day: number })) throw error(409, 'Des joueurs ont déjà répondu à cette case');
  const doc = await cases(db).findOneAndDelete({ event_id: eventId, day: number });
  if (!doc) throw error(404, 'Case introuvable');
  await removeClue(doc.clue_path);
};

/** A character to suggest: game artwork available, not already used in this calendar. */
export const randomCharacter = async (db, eventId) => {
  const used = (await cases(db).find({ event_id: eventId }, { projection: { character_id: 1 } }).toArray()).map((c) => c.character_id);
  const [character] = await db.collection('characters').aggregate([
    { $match: { 'source_images.artwork': { $type: 'string' }, _id: { $nin: used.filter(ObjectId.isValid).map((id) => new ObjectId(id)) } } },
    { $sample: { size: 1 } },
    { $project: { name: 1, version: 1, version_name: 1, images_version: 1 } },
  ]).toArray();
  if (!character) throw error(404, 'Aucun perso disponible');
  return character;
};

export const characterAccepted = async (db, characterId) => {
  const character = await characterOf(db, characterId);
  if (!character) throw error(404, 'Perso introuvable');
  const quote = character.quote?.fr ?? (typeof character.quote === 'string' ? character.quote : null);
  return { accepted: defaultAccepted(character), quote, has_artwork: Boolean(character.source_images?.artwork) };
};

export const listCaseAnswers = async (db, eventId, day) => answers(db)
  .find({ event_id: eventId, day: Number(day) }, { projection: { answer: 1, status: 1, reviewed: 1, accepted: 1, late: 1, answered_at: 1, bbs_name: 1, user_name: 1 } })
  .sort({ answered_at: 1 })
  .toArray();

/** Accepts or refuses a close answer. */
export const reviewCaseAnswer = async (db, answerId, accept) => {
  if (!ObjectId.isValid(answerId)) throw error(400, 'Identifiant invalide');
  const result = await answers(db).findOneAndUpdate(
    { _id: new ObjectId(answerId), status: 'pending' },
    { $set: { reviewed: true, accepted: Boolean(accept) } },
    { returnDocument: 'after' },
  );
  if (!result) throw error(404, 'Réponse introuvable');
  return result;
};

// ---------- Player ----------

const answerPoints = (event, answer) => {
  const right = answer.status === 'correct' || (answer.status === 'pending' && answer.accepted === true);
  return right ? adventOf(event).points * (answer.late ? LATE_RATIO : 1) : 0;
};

// What the player sees of an answer: a close answer stays "pending" until an admin decides
const answerView = (event, answer) => ({
  answer: answer.answer,
  late: answer.late,
  result: answer.status === 'pending' && !answer.reviewed ? 'pending'
    : answer.status === 'correct' || answer.accepted ? 'correct' : 'wrong',
  points: answerPoints(event, answer),
});

const rank = (rows) => {
  const sorted = [...rows].sort((a, b) => b.points - a.points || b.found - a.found || a.last - b.last);
  let current = 0;
  return sorted.map((row, index) => {
    if (index === 0 || row.points !== sorted[index - 1].points) current = index + 1;
    const shown = { ...row, rank: current };
    delete shown.last;
    return shown;
  });
};

const rankings = async (db, event, list) => {
  const byUser = new Map();
  for (const answer of list) {
    const row = byUser.get(answer.user_id) ?? { user_id: answer.user_id, points: 0, found: 0, last: 0 };
    const points = answerPoints(event, answer);
    row.points += points;
    if (points > 0) row.found += 1;
    // The latest answer gives the name and the guild shown
    if (answer.answered_at.getTime() >= row.last) {
      Object.assign(row, {
        last: answer.answered_at.getTime(), name: answer.bbs_name || answer.user_name || 'Joueur', bbs_id: answer.bbs_id ?? null,
        guild_name: answer.guild_name, in_guild: answer.in_guild,
      });
    }
    byUser.set(answer.user_id, row);
  }
  const rows = await withPlayers(db, [...byUser.values()]);
  return { all: rank(rows), guild: rank(rows.filter((r) => r.in_guild)), free: rank(rows.filter((r) => !r.in_guild)) };
};

/** The calendar as a visitor sees it: opened cases with their clue, the player's answers, the rankings. */
export const getCalendar = async (db, eventId, token, now = new Date()) => {
  const event = await getEventById(db, eventId);
  if (!adventOf(event).enabled) throw error(404, 'Pas de calendrier pour cet événement');
  const over = isEventOver(event, now);
  const list = await cases(db).find({ event_id: eventId }).toArray();
  const byDay = new Map(list.map((c) => [c.day, c]));
  const all = await answers(db).find({ event_id: eventId }).toArray();
  const key = userKey(token);
  const mine = new Map(all.filter((a) => key && a.user_id === key).map((a) => [a.day, a]));
  const revealed = over ? await db.collection('characters')
    .find({ _id: { $in: list.map((c) => c.character_id).filter(ObjectId.isValid).map((id) => new ObjectId(id)) } }, { projection: { name: 1, version: 1, images_version: 1 } })
    .toArray() : [];
  const characterById = new Map(revealed.map((c) => [c._id.toString(), c]));

  const days = Array.from({ length: dayCount(event) }, (_, i) => {
    const day = i + 1;
    const openAt = opensAt(event, day);
    const item = byDay.get(day);
    const opened = now >= openAt && item;
    // A case whose day has come but that no admin filled yet
    const state = now < openAt ? 'locked' : !item ? 'empty'
      : over ? 'over' : now < new Date(openAt.getTime() + DAY_MS) ? 'today' : 'late';
    return {
      day,
      opens_at: openAt,
      state,
      ...(opened && { clue: { type: item.clue_type, path: item.clue_path, text: item.clue_text } }),
      mine: mine.has(day) ? answerView(event, mine.get(day)) : null,
      ...(over && item && { character: characterById.get(item.character_id) ?? null }),
    };
  });
  return {
    event: { _id: event._id, name: event.name, start_at: event.start_at, end_at: event.end_at },
    advent: { points: adventOf(event).points, late_ratio: LATE_RATIO },
    now,
    days,
    rankings: await rankings(db, event, all),
  };
};

/** Records the answer to a case; one per player and case. */
export const answerCase = async (db, eventId, day, token, text, now = new Date()) => {
  const event = await getEventById(db, eventId);
  if (!adventOf(event).enabled) throw error(404, 'Pas de calendrier pour cet événement');
  if (!isEventOpen(event, now)) throw error(403, 'L\'événement n\'est pas en cours');
  const number = Number(day);
  const item = await cases(db).findOne({ event_id: eventId, day: number });
  if (!item || now < opensAt(event, number)) throw error(403, 'Cette case n\'est pas encore ouverte');
  const answer = String(text ?? '').trim().slice(0, 120);
  if (!answer) throw error(400, 'Écris un nom');
  const key = userKey(token);
  if (!key) throw error(401, 'Connexion requise');

  const user = await findTokenUser(db, token);
  const doc = {
    event_id: eventId,
    day: number,
    user_id: key,
    user_name: user?.global_name || user?.username || null,
    ...(await guildSnapshot(db, user)),
    answer,
    status: matchFreeText(answer, item.accepted),
    late: now.getTime() >= opensAt(event, number).getTime() + DAY_MS,
    answered_at: now,
  };
  await ensureAnswerIndex(db);
  try {
    await answers(db).insertOne(doc);
  } catch (err) {
    if (err.code === 11000) throw error(409, 'Tu as déjà répondu à cette case');
    throw err;
  }
  await awardEventBadge(db, event, key, 'advent', now);
  return answerView(event, doc);
};

export const deleteEventAdvent = async (db, eventId) => {
  const list = await cases(db).find({ event_id: eventId }, { projection: { clue_path: 1 } }).toArray();
  await Promise.all(list.map((c) => removeClue(c.clue_path)));
  await cases(db).deleteMany({ event_id: eventId });
  await answers(db).deleteMany({ event_id: eventId });
};

export const adventHasAnswers = async (db, eventId) => (await answers(db).countDocuments({ event_id: eventId })) > 0;
