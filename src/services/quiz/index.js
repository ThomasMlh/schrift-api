import { ObjectId } from 'mongodb';
import { getPrimaryAccount } from '../../utils/bbsAccounts.js';
import { gradeAnswer, SUPPORT_DURATIONS, timeBonus } from './grading.js';
import { correctAnswer, playerQuestion, sanitizeQuestion, seededShuffle } from './questions.js';
import { awardEventBadge, deleteEventBadges } from '../eventBadges.js';
import { withPlayers } from './players.js';
import { adventHasAnswers, deleteEventAdvent, sanitizeAdvent } from '../advent/index.js';

export const EVENT_KINDS = ['anniversary', 'other'];
export const DEFAULT_BONUS_RATIO = 0.1;
// Extra seconds the server waits past a question's time: network and media loading
const GRACE_SECONDS = { text: 3, image: 6, video: 10, audio: 8 };

const error = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const toObjectId = (id, label = 'Identifiant') => {
  if (!ObjectId.isValid(id)) throw error(400, `${label} invalide`);
  return new ObjectId(id);
};
const round = (value) => Math.round(value * 100) / 100;
const parseDate = (value, label) => {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) throw error(400, `${label} invalide`);
  return date;
};

const events = (db) => db.collection('events');
const quizzes = (db) => db.collection('quizzes');
const attempts = (db) => db.collection('quiz_attempts');
// Admin rehearsals: same flow as a real attempt, kept apart from the rankings
const testAttempts = (db) => db.collection('quiz_test_attempts');
export const mediaCollection = (db) => db.collection('quiz_media');

// The unique index keeps one attempt per account; created once per process before the first start
const indexReady = new WeakMap();
const ensureAttemptIndex = (db) => {
  if (!indexReady.has(db)) indexReady.set(db, attempts(db).createIndex({ quiz_id: 1, user_id: 1 }, { unique: true }));
  return indexReady.get(db);
};

// ---------- Events ----------

const sanitizeEvent = (input) => {
  const name = String(input?.name ?? '').trim().slice(0, 120);
  if (!name) throw error(400, 'Le nom de l\'événement est vide');
  const startAt = parseDate(input?.start_at, 'Date de début');
  const endAt = parseDate(input?.end_at, 'Date de fin');
  if (endAt <= startAt) throw error(400, 'La fin doit être après le début');
  return {
    name,
    kind: EVENT_KINDS.includes(input?.kind) ? input.kind : 'other',
    description: String(input?.description ?? '').trim().slice(0, 2000),
    start_at: startAt,
    end_at: endAt,
    // Limited edition badge given to the participants; empty: no badge
    badge_name: String(input?.badge_name ?? '').trim().slice(0, 60) || null,
    advent: sanitizeAdvent(input?.advent),
  };
};

export const listEvents = (db) => events(db).find({}).sort({ start_at: -1 }).toArray();

export const createEvent = async (db, input) => {
  const now = new Date();
  const doc = { ...sanitizeEvent(input), created_at: now, updated_at: now };
  const { insertedId } = await events(db).insertOne(doc);
  return { _id: insertedId, ...doc };
};

export const updateEvent = async (db, id, input) => {
  const result = await events(db).findOneAndUpdate(
    { _id: toObjectId(id) },
    { $set: { ...sanitizeEvent(input), updated_at: new Date() } },
    { returnDocument: 'after' },
  );
  if (!result) throw error(404, 'Événement introuvable');
  return result;
};

export const deleteEvent = async (db, id) => {
  const eventId = toObjectId(id);
  const quizIds = (await quizzes(db).find({ event_id: id }, { projection: { _id: 1 } }).toArray()).map((q) => q._id.toString());
  if (quizIds.length && await attempts(db).countDocuments({ quiz_id: { $in: quizIds } })) {
    throw error(409, 'Des joueurs ont déjà participé : l\'événement ne peut plus être supprimé');
  }
  if (await adventHasAnswers(db, id)) throw error(409, 'Des joueurs ont déjà ouvert le calendrier : l\'événement ne peut plus être supprimé');
  if (await mediaCollection(db).countDocuments({ event_id: id })) {
    throw error(409, 'Vide d\'abord la médiathèque de l\'événement');
  }
  await quizzes(db).deleteMany({ event_id: id });
  if (quizIds.length) await testAttempts(db).deleteMany({ quiz_id: { $in: quizIds } });
  await deleteEventAdvent(db, id);
  await deleteEventBadges(db, id);
  const { deletedCount } = await events(db).deleteOne({ _id: eventId });
  if (!deletedCount) throw error(404, 'Événement introuvable');
};

export const getEventById = async (db, id) => {
  const event = await events(db).findOne({ _id: toObjectId(id) });
  if (!event) throw error(404, 'Événement introuvable');
  return event;
};

// ---------- Quizzes (admin) ----------

const totalPoints = (quiz) => round((quiz.questions ?? []).reduce((sum, q) => sum + q.points, 0));

export const quizSummary = (quiz) => ({
  _id: quiz._id,
  event_id: quiz.event_id,
  title: quiz.title,
  description: quiz.description,
  status: quiz.status,
  question_count: quiz.questions?.length ?? 0,
  total_points: totalPoints(quiz),
  duration_seconds: (quiz.questions ?? []).reduce((sum, q) => sum + SUPPORT_DURATIONS[q.support], 0),
  bonus_ratio: quiz.bonus_ratio,
  shuffle: Boolean(quiz.shuffle),
});

export const createQuiz = async (db, eventId, input) => {
  await getEventById(db, eventId);
  const now = new Date();
  const doc = {
    event_id: eventId,
    title: String(input?.title ?? '').trim().slice(0, 120) || 'Quiz',
    description: String(input?.description ?? '').trim().slice(0, 2000),
    status: 'draft',
    bonus_ratio: DEFAULT_BONUS_RATIO,
    questions: [],
    created_at: now,
    updated_at: now,
  };
  const { insertedId } = await quizzes(db).insertOne(doc);
  return { _id: insertedId, ...doc };
};

export const getQuiz = async (db, id) => {
  const quiz = await quizzes(db).findOne({ _id: toObjectId(id) });
  if (!quiz) throw error(404, 'Quiz introuvable');
  return quiz;
};

export const listEventQuizzes = (db, eventId) => quizzes(db).find({ event_id: eventId }).sort({ created_at: 1 }).toArray();

export const updateQuiz = async (db, id, input) => {
  const quiz = await getQuiz(db, id);
  const set = { updated_at: new Date() };
  if (input.title !== undefined) set.title = String(input.title).trim().slice(0, 120) || quiz.title;
  if (input.description !== undefined) set.description = String(input.description).trim().slice(0, 2000);
  if (input.bonus_ratio !== undefined) {
    const ratio = Number(input.bonus_ratio);
    if (!(ratio >= 0 && ratio <= 0.5)) throw error(400, 'Bonus de chrono : entre 0 et 50 %');
    set.bonus_ratio = ratio;
  }
  if (input.questions !== undefined) {
    if (!Array.isArray(input.questions) || input.questions.length > 100) throw error(400, 'Liste de questions invalide');
    const media = await mediaCollection(db).find({ event_id: quiz.event_id, status: 'ready' }, { projection: { _id: 1 } }).toArray();
    const mediaIds = new Set(media.map((m) => m._id.toString()));
    set.questions = input.questions.map((q, i) => sanitizeQuestion(q, i, mediaIds));
  }
  if (input.shuffle !== undefined) set.shuffle = Boolean(input.shuffle);
  if (input.status !== undefined) {
    if (!['draft', 'published'].includes(input.status)) throw error(400, 'Statut invalide');
    if (input.status === 'published' && !(set.questions ?? quiz.questions).length) throw error(400, 'Ajoute au moins une question avant de publier');
    set.status = input.status;
  }
  return quizzes(db).findOneAndUpdate({ _id: quiz._id }, { $set: set }, { returnDocument: 'after' });
};

export const deleteQuiz = async (db, id) => {
  const quiz = await getQuiz(db, id);
  if (await attempts(db).countDocuments({ quiz_id: quiz._id.toString() })) {
    throw error(409, 'Des joueurs ont déjà participé : le quiz ne peut plus être supprimé');
  }
  await quizzes(db).deleteOne({ _id: quiz._id });
  await testAttempts(db).deleteMany({ quiz_id: quiz._id.toString() });
};

// ---------- Player side ----------

export const isEventOpen = (event, now) => now >= event.start_at && now <= event.end_at;
export const isEventOver = (event, now) => now > event.end_at;
const isOpen = isEventOpen;
const isOver = isEventOver;

// Bbs account shown for the player and whether it was in an active guild when the quiz started
export const guildSnapshot = async (db, user) => {
  const accounts = user?.bbs_accounts ?? [];
  const guildIds = [...new Set(accounts.map((a) => a.guilde_id).filter(Boolean))];
  const guilds = guildIds.length
    ? await db.collection('guildes').find(
      { _id: { $in: guildIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id)) }, disabled: { $ne: true } },
      { projection: { name: 1 } },
    ).toArray()
    : [];
  const active = new Map(guilds.map((g) => [g._id.toString(), g.name]));
  const primary = getPrimaryAccount(accounts);
  const account = (primary && active.has(primary.guilde_id) ? primary : accounts.find((a) => active.has(a.guilde_id))) ?? primary;
  const inGuild = Boolean(account && active.has(account.guilde_id));
  return {
    bbs_id: account?.bbs_id ?? null,
    bbs_name: account?.bbs_name ?? null,
    guild_id: inGuild ? account.guilde_id : null,
    guild_name: inGuild ? active.get(account.guilde_id) : null,
    in_guild: inGuild,
  };
};

export const findTokenUser = async (db, token) => {
  if (token?._id && ObjectId.isValid(token._id)) {
    const user = await db.collection('users').findOne({ _id: new ObjectId(token._id) });
    if (user) return user;
  }
  return token?.discord_id ? db.collection('users').findOne({ discord_id: token.discord_id }) : null;
};

export const userKey = (token) => String(token?._id ?? token?.discord_id ?? '');

// Order of the questions for an attempt: the quiz order, or a per-player shuffle
const questionOrder = (quiz, attempt) => (quiz.shuffle ? seededShuffle(quiz.questions, attempt._id.toString()) : quiz.questions);

const deadlineOf = (question, servedAt) =>
  servedAt.getTime() + (SUPPORT_DURATIONS[question.support] + GRACE_SECONDS[question.support]) * 1000;

/**
 * Moves the attempt past every question whose time ran out while the player was away (a missed
 * question scores 0), then serves the current one. Returns the updated attempt.
 */
const catchUp = async (db, quiz, attempt, now, store = attempts(db)) => {
  const order = questionOrder(quiz, attempt);
  let { current_index: index, current_served_at: servedAt } = attempt;
  const missed = [];
  while (index < order.length && servedAt && now.getTime() > deadlineOf(order[index], servedAt)) {
    missed.push({ question_id: order[index].id, answer: null, missed: true, answered_at: null, remaining_ms: 0 });
    index += 1;
    servedAt = null;
  }
  const finished = index >= order.length;
  if (!finished && !servedAt) servedAt = now;
  if (index === attempt.current_index && servedAt === attempt.current_served_at) return attempt;

  const set = { current_index: index, current_served_at: finished ? null : servedAt, ...(finished && { finished_at: attempt.finished_at ?? now }) };
  const updated = await store.findOneAndUpdate(
    { _id: attempt._id, current_index: attempt.current_index },
    { $set: set, ...(missed.length && { $push: { answers: { $each: missed } } }) },
    { returnDocument: 'after' },
  );
  // Another request moved it first: use its result
  return updated ?? store.findOne({ _id: attempt._id });
};

const mediaPaths = async (db, ids) => {
  const list = ids.length
    ? await mediaCollection(db).find({ _id: { $in: ids.map((id) => new ObjectId(id)) } }, { projection: { path: 1, kind: 1 } }).toArray()
    : [];
  return new Map(list.map((m) => [m._id.toString(), m]));
};

// What the play page needs: the current question with its deadline, or the end screen
const attemptState = async (db, quiz, attempt, now) => {
  const order = questionOrder(quiz, attempt);
  const base = { attempt_id: attempt._id, total: order.length, answered: attempt.answers.length, now: now.toISOString() };
  if (attempt.finished_at || attempt.current_index >= order.length) return { ...base, status: 'finished', finished_at: attempt.finished_at };
  const question = order[attempt.current_index];
  const media = question.media_id ? (await mediaPaths(db, [question.media_id])).get(question.media_id) : null;
  const durationMs = SUPPORT_DURATIONS[question.support] * 1000;
  return {
    ...base,
    status: 'in_progress',
    index: attempt.current_index,
    question: { ...playerQuestion(question, attempt._id.toString()), media: media ? { path: media.path, kind: media.kind } : null },
    served_at: attempt.current_served_at,
    // The time shown to the player; the server keeps a few more seconds of margin
    ends_at: new Date(new Date(attempt.current_served_at).getTime() + durationMs).toISOString(),
  };
};

// Public view of an event, with the player's state on each quiz when logged in
export const getPublicEvent = async (db, { kind, id }, token, now = new Date()) => {
  const event = id
    ? await getEventById(db, id)
    : await events(db).find({ kind: kind ?? 'anniversary' }).sort({ start_at: -1 }).limit(1).next();
  if (!event) throw error(404, 'Aucun événement');
  const list = (await listEventQuizzes(db, event._id.toString())).filter((q) => q.status === 'published');
  const key = userKey(token);
  const mine = key
    ? await attempts(db).find({ quiz_id: { $in: list.map((q) => q._id.toString()) }, user_id: key }).toArray()
    : [];
  return {
    event: {
      _id: event._id, name: event.name, kind: event.kind, description: event.description, start_at: event.start_at, end_at: event.end_at,
      badge_name: event.badge_name ?? null,
      advent_enabled: Boolean(event.advent?.enabled),
    },
    my_badge: key ? Boolean(await db.collection('event_badges').findOne({ event_id: event._id.toString(), user_id: key })) : false,
    state: now < event.start_at ? 'upcoming' : isOver(event, now) ? 'over' : 'open',
    quizzes: list.map((quiz) => {
      const attempt = mine.find((a) => a.quiz_id === quiz._id.toString());
      const finished = attempt && (attempt.finished_at || attempt.current_index >= quiz.questions.length);
      return { ...quizSummary(quiz), my_attempt: attempt ? (finished ? 'finished' : 'in_progress') : null };
    }),
  };
};

// Finishing the quiz while the event runs earns its badge
const withBadge = async (db, event, token, state, now) => {
  if (state.status === 'finished') await awardEventBadge(db, event, userKey(token), 'quiz', now);
  return state;
};

const playableQuiz = async (db, quizId, now) => {
  const quiz = await getQuiz(db, quizId);
  if (quiz.status !== 'published') throw error(404, 'Quiz introuvable');
  const event = await getEventById(db, quiz.event_id);
  return { quiz, event, open: isOpen(event, now) };
};

export const startAttempt = async (db, quizId, token, now = new Date()) => {
  const { quiz, event, open } = await playableQuiz(db, quizId, now);
  const key = userKey(token);
  if (!key) throw error(401, 'Connexion requise');
  const existing = await attempts(db).findOne({ quiz_id: quiz._id.toString(), user_id: key });
  if (existing) return withBadge(db, event, token, await attemptState(db, quiz, await catchUp(db, quiz, existing, now), now), now);
  if (!open) throw error(403, 'Le quiz n\'est pas ouvert');

  await ensureAttemptIndex(db);
  const user = await findTokenUser(db, token);
  const doc = {
    quiz_id: quiz._id.toString(),
    user_id: key,
    user_name: user?.global_name || user?.username || null,
    ...(await guildSnapshot(db, user)),
    started_at: now,
    finished_at: null,
    current_index: 0,
    current_served_at: now,
    answers: [],
    reviews: {},
  };
  try {
    const { insertedId } = await attempts(db).insertOne(doc);
    return attemptState(db, quiz, { _id: insertedId, ...doc }, now);
  } catch (err) {
    // Two starts at once: the unique index keeps one attempt
    if (err.code !== 11000) throw err;
    const attempt = await attempts(db).findOne({ quiz_id: quiz._id.toString(), user_id: key });
    return attemptState(db, quiz, attempt, now);
  }
};

const myAttempt = async (db, quiz, token) => {
  const attempt = await attempts(db).findOne({ quiz_id: quiz._id.toString(), user_id: userKey(token) });
  if (!attempt) throw error(404, 'Aucune participation');
  return attempt;
};

export const getAttemptState = async (db, quizId, token, now = new Date()) => {
  const { quiz, event } = await playableQuiz(db, quizId, now);
  const attempt = await myAttempt(db, quiz, token);
  return withBadge(db, event, token, await attemptState(db, quiz, await catchUp(db, quiz, attempt, now), now), now);
};

/**
 * Records the answer to the current question and serves the next one. An answer to another question
 * (already skipped, double click) is ignored and the current state is returned.
 */
export const submitAnswer = async (db, quizId, token, input, now = new Date()) => {
  const { quiz, event } = await playableQuiz(db, quizId, now);
  return withBadge(db, event, token, await recordAnswer(db, attempts(db), quiz, await myAttempt(db, quiz, token), input, now), now);
};

const recordAnswer = async (db, store, quiz, current, { question_id: questionId, answer } = {}, now = new Date()) => {
  const attempt = await catchUp(db, quiz, current, now, store);
  const order = questionOrder(quiz, attempt);
  const question = order[attempt.current_index];
  if (attempt.finished_at || !question || question.id !== questionId) return { ...(await attemptState(db, quiz, attempt, now)), ignored: true };

  const servedAt = new Date(attempt.current_served_at).getTime();
  const durationMs = SUPPORT_DURATIONS[question.support] * 1000;
  const remainingMs = Math.max(0, Math.min(durationMs, deadlineOf(question, new Date(servedAt)) - now.getTime()));
  const nextIndex = attempt.current_index + 1;
  const finished = nextIndex >= order.length;
  const updated = await store.findOneAndUpdate(
    { _id: attempt._id, current_index: attempt.current_index },
    {
      $push: { answers: { question_id: question.id, answer: answer ?? null, missed: false, answered_at: now, remaining_ms: remainingMs } },
      $set: { current_index: nextIndex, current_served_at: finished ? null : now, ...(finished && { finished_at: now }) },
    },
    { returnDocument: 'after' },
  );
  return attemptState(db, quiz, updated ?? await store.findOne({ _id: attempt._id }), now);
};

// ---------- Scores and results ----------

/** Grades a whole attempt against the current questions, so a fixed answer key applies to everyone. */
export const scoreAttempt = (quiz, attempt) => {
  const byId = new Map(quiz.questions.map((q) => [q.id, q]));
  const ratio = quiz.bonus_ratio ?? DEFAULT_BONUS_RATIO;
  let points = 0;
  let bonus = 0;
  const details = attempt.answers.map((entry) => {
    const question = byId.get(entry.question_id);
    if (!question) return { ...entry, points: 0, max: 0, bonus: 0, pending: [] };
    const graded = gradeAnswer(question, entry.missed ? null : entry.answer, attempt.reviews?.[question.id] ?? []);
    // A part an admin refused no longer waits for a review
    const refused = attempt.refused?.[question.id] ?? [];
    graded.pending = graded.pending.filter((key) => !refused.includes(key));
    const entryBonus = timeBonus({
      points: graded.points, remainingMs: entry.remaining_ms, durationMs: SUPPORT_DURATIONS[question.support] * 1000, ratio,
    });
    points += graded.points;
    bonus += entryBonus;
    return { ...entry, ...graded, bonus: entryBonus };
  });
  return {
    points: round(points),
    bonus: round(bonus),
    total: round(points + bonus),
    max_points: totalPoints(quiz),
    max_bonus: round(totalPoints(quiz) * ratio),
    pending: details.reduce((sum, d) => sum + d.pending.length, 0),
    details,
  };
};

// Best total first; equal totals share their rank
const rank = (rows) => {
  const sorted = [...rows].sort((a, b) => b.total - a.total);
  let current = 0;
  return sorted.map((row, index) => {
    if (index === 0 || row.total !== sorted[index - 1].total) current = index + 1;
    return { ...row, rank: current };
  });
};


const resultRow = (quiz, attempt) => {
  const score = scoreAttempt(quiz, attempt);
  return {
    attempt_id: attempt._id,
    user_id: attempt.user_id,
    bbs_id: attempt.bbs_id ?? null,
    name: attempt.bbs_name || attempt.user_name || 'Joueur',
    guild_name: attempt.guild_name,
    in_guild: attempt.in_guild,
    points: score.points,
    bonus: score.bonus,
    total: score.total,
    duration_ms: attempt.finished_at ? new Date(attempt.finished_at) - new Date(attempt.started_at) : null,
  };
};

/** The 3 rankings, readable once the event is over (or by an admin). */
export const getResults = async (db, quizId, token, now = new Date()) => {
  const quiz = await getQuiz(db, quizId);
  const event = await getEventById(db, quiz.event_id);
  if (!token?.is_admin && (quiz.status !== 'published' || !isOver(event, now))) {
    throw error(403, 'Les résultats seront révélés à la fin de l\'événement');
  }
  // An attempt left in the middle still ranks: the questions it never answered score 0
  const rows = await withPlayers(db, (await attempts(db).find({ quiz_id: quiz._id.toString() }).toArray()).map((a) => resultRow(quiz, a)));
  const key = userKey(token);
  const mine = key ? await attempts(db).findOne({ quiz_id: quiz._id.toString(), user_id: key }) : null;
  const myScore = mine ? scoreAttempt(quiz, mine) : null;
  const byId = new Map(quiz.questions.map((q) => [q.id, q]));
  return {
    quiz: quizSummary(quiz),
    rankings: {
      all: rank(rows),
      guild: rank(rows.filter((r) => r.in_guild)),
      free: rank(rows.filter((r) => !r.in_guild)),
    },
    mine: myScore && {
      ...myScore,
      details: myScore.details.map((d) => ({
        question_id: d.question_id,
        prompt: byId.get(d.question_id)?.prompt ?? '',
        points: d.points,
        max: d.max,
        bonus: d.bonus,
        missed: d.missed,
        correct: byId.get(d.question_id) ? correctAnswer(byId.get(d.question_id)) : [],
      })),
    },
  };
};

// ---------- Admin follow-up ----------

export const listAttempts = async (db, quizId, now = new Date()) => {
  const quiz = await getQuiz(db, quizId);
  const list = await attempts(db).find({ quiz_id: quiz._id.toString() }).sort({ started_at: 1 }).toArray();
  return withPlayers(db, list.map((attempt) => {
    const score = scoreAttempt(quiz, attempt);
    const finished = Boolean(attempt.finished_at) || attempt.current_index >= quiz.questions.length;
    return {
      ...resultRow(quiz, attempt),
      started_at: attempt.started_at,
      finished_at: attempt.finished_at,
      status: finished ? 'finished' : 'in_progress',
      progress: attempt.current_index,
      pending: score.pending,
      // An attempt left in the middle is only stale for the admin view
      idle: !finished && attempt.current_served_at && now - new Date(attempt.current_served_at) > 5 * 60 * 1000,
    };
  }));
};

export const getAttemptDetail = async (db, attemptId) => {
  const attempt = await attempts(db).findOne({ _id: toObjectId(attemptId) });
  if (!attempt) throw error(404, 'Participation introuvable');
  return attemptDetail(await getQuiz(db, attempt.quiz_id), attempt);
};

const attemptDetail = (quiz, attempt) => {
  const score = scoreAttempt(quiz, attempt);
  const byId = new Map(quiz.questions.map((q) => [q.id, q]));
  return {
    ...resultRow(quiz, attempt),
    started_at: attempt.started_at,
    finished_at: attempt.finished_at,
    score: { points: score.points, bonus: score.bonus, total: score.total, max_points: score.max_points, max_bonus: score.max_bonus },
    answers: score.details.map((d) => ({ ...d, question: byId.get(d.question_id) ?? null, accepted: attempt.reviews?.[d.question_id] ?? [] })),
  };
};

/** Accepts or refuses a free text part an admin reviewed ('text' or a blank index). */
export const reviewAnswer = async (db, attemptId, { question_id: questionId, key, accept }) => {
  const attempt = await attempts(db).findOne({ _id: toObjectId(attemptId) });
  if (!attempt) throw error(404, 'Participation introuvable');
  const current = new Set(attempt.reviews?.[questionId] ?? []);
  if (accept) current.add(String(key)); else current.delete(String(key));
  // Refused parts are remembered too, so they leave the "to check" list
  const refused = new Set(attempt.refused?.[questionId] ?? []);
  if (accept) refused.delete(String(key)); else refused.add(String(key));
  await attempts(db).updateOne(
    { _id: attempt._id },
    { $set: { [`reviews.${questionId}`]: [...current], [`refused.${questionId}`]: [...refused] } },
  );
  return getAttemptDetail(db, attemptId);
};

// Lets a player start over (bug, wrong account…)
export const deleteAttempt = async (db, attemptId) => {
  const { deletedCount } = await attempts(db).deleteOne({ _id: toObjectId(attemptId) });
  if (!deletedCount) throw error(404, 'Participation introuvable');
};

// ---------- Admin rehearsal ----------
// An admin plays the saved quiz as a player would, whatever its status and the event dates. The
// rehearsal lives in its own collection, so it never shows in the participants or the rankings.

const testAttempt = async (db, quiz, token) => {
  const attempt = await testAttempts(db).findOne({ quiz_id: quiz._id.toString(), user_id: userKey(token) });
  if (!attempt) throw error(404, 'Aucun test en cours');
  return attempt;
};

/** Starts a rehearsal from the first question; a previous one is dropped. */
export const startTestAttempt = async (db, quizId, token, now = new Date()) => {
  const quiz = await getQuiz(db, quizId);
  if (!quiz.questions?.length) throw error(400, 'Ajoute au moins une question avant de tester');
  const key = userKey(token);
  if (!key) throw error(401, 'Connexion requise');
  await testAttempts(db).deleteMany({ quiz_id: quiz._id.toString(), user_id: key });
  const user = await findTokenUser(db, token);
  const doc = {
    quiz_id: quiz._id.toString(),
    user_id: key,
    user_name: user?.global_name || user?.username || null,
    in_guild: false,
    started_at: now,
    finished_at: null,
    current_index: 0,
    current_served_at: now,
    answers: [],
    reviews: {},
  };
  const { insertedId } = await testAttempts(db).insertOne(doc);
  return attemptState(db, quiz, { _id: insertedId, ...doc }, now);
};

export const getTestState = async (db, quizId, token, now = new Date()) => {
  const quiz = await getQuiz(db, quizId);
  return attemptState(db, quiz, await catchUp(db, quiz, await testAttempt(db, quiz, token), now, testAttempts(db)), now);
};

export const submitTestAnswer = async (db, quizId, token, input, now = new Date()) => {
  const quiz = await getQuiz(db, quizId);
  return recordAnswer(db, testAttempts(db), quiz, await testAttempt(db, quiz, token), input, now);
};

/** Score and correction of the rehearsal, with the answer key of each question. */
export const getTestResult = async (db, quizId, token) => {
  const quiz = await getQuiz(db, quizId);
  return attemptDetail(quiz, await testAttempt(db, quiz, token));
};
