// Community goal of an event: every contribution during the event fills one shared gauge (scores
// entered, calendar cases found, quizzes finished, gifts found), each worth a number of points.
// Tiers along the gauge unlock rewards for everyone: the festive decor of the site, an avatar frame
// for the participants, or a reward written by an admin and handed out by hand.

export const GOAL_SOURCES = ['score', 'advent', 'quiz', 'gift'];
export const TIER_REWARDS = ['decor', 'frame', 'custom'];
export const DEFAULT_GOAL = { enabled: false, weights: { score: 1, advent: 3, quiz: 10, gift: 3 }, tiers: [] };

const error = (statusCode, message) => Object.assign(new Error(message), { statusCode });

export const sanitizeGoal = (input = {}) => {
  const weights = Object.fromEntries(GOAL_SOURCES.map((source) => {
    const value = Number(input?.weights?.[source]);
    return [source, Number.isFinite(value) ? Math.round(Math.max(0, Math.min(1000, value))) : DEFAULT_GOAL.weights[source]];
  }));
  const tiers = (Array.isArray(input?.tiers) ? input.tiers : []).slice(0, 10).map((tier) => {
    const threshold = Math.round(Number(tier?.threshold));
    if (!Number.isFinite(threshold) || threshold < 1) throw error(400, 'Chaque palier doit avoir un seuil positif');
    const reward = TIER_REWARDS.includes(tier?.reward) ? tier.reward : 'custom';
    const label = String(tier?.label ?? '').trim().slice(0, 120);
    if (reward === 'custom' && !label) throw error(400, 'Décris la récompense du palier');
    return { threshold, reward, label };
  }).sort((a, b) => a.threshold - b.threshold);
  return { enabled: Boolean(input?.enabled), weights, tiers };
};

export const goalOf = (event) => {
  const goal = event?.goal ?? {};
  return { ...DEFAULT_GOAL, ...goal, weights: { ...DEFAULT_GOAL.weights, ...(goal.weights ?? {}) }, tiers: goal.tiers ?? [] };
};

const countContributions = async (db, event, now) => {
  const eventId = event._id.toString();
  const until = now < event.end_at ? now : event.end_at;
  const quizIds = (await db.collection('quizzes').find({ event_id: eventId }, { projection: { _id: 1 } }).toArray()).map((q) => q._id.toString());
  const [score, advent, quiz, gift] = await Promise.all([
    db.collection('scores').countDocuments({ score: { $gt: 0 }, created_at: { $gte: event.start_at, $lte: until } }),
    db.collection('advent_answers').countDocuments({ event_id: eventId, $or: [{ status: 'correct' }, { status: 'pending', accepted: true }] }),
    quizIds.length ? db.collection('quiz_attempts').countDocuments({ quiz_id: { $in: quizIds }, finished_at: { $ne: null } }) : 0,
    db.collection('hunt_finds').countDocuments({ event_id: eventId }),
  ]);
  return { score, advent, quiz, gift };
};

/** Gauge of an event: contributions by source, total points and the tiers reached. */
export const goalProgress = async (db, event, now = new Date()) => {
  const goal = goalOf(event);
  if (!goal.enabled) return null;
  const counts = now < event.start_at ? { score: 0, advent: 0, quiz: 0, gift: 0 } : await countContributions(db, event, now);
  const total = GOAL_SOURCES.reduce((sum, source) => sum + counts[source] * goal.weights[source], 0);
  return {
    total,
    counts,
    weights: goal.weights,
    target: goal.tiers.at(-1)?.threshold ?? null,
    tiers: goal.tiers.map((tier) => ({ ...tier, reached: total >= tier.threshold })),
  };
};

// The live state is read by every page of the site: kept a minute per server instance
const LIVE_TTL_MS = 60 * 1000;
const liveCache = new WeakMap();

/**
 * What the whole site needs from the running event: whether the festive decor is on, the accounts
 * wearing the avatar frame, and whether a gift hunt runs. null when no event with a goal or a hunt runs.
 */
export const getLiveEvent = async (db, now = new Date()) => {
  const cached = liveCache.get(db);
  if (cached && now - cached.at < LIVE_TTL_MS) return cached.value;

  const [event] = await db.collection('events')
    .find({ $or: [{ 'goal.enabled': true }, { 'hunt.enabled': true }], start_at: { $lte: now }, end_at: { $gte: now } })
    .sort({ start_at: -1 }).limit(1).toArray();
  let value = null;
  if (event) {
    const progress = await goalProgress(db, event, now);
    const unlocked = new Set((progress?.tiers ?? []).filter((t) => t.reached).map((t) => t.reward));
    const framed = unlocked.has('frame')
      ? (await db.collection('event_badges').find({ event_id: event._id.toString() }, { projection: { user_id: 1 } }).toArray()).map((b) => b.user_id)
      : [];
    value = {
      event_id: event._id.toString(),
      name: event.name,
      year: new Date(event.start_at).getUTCFullYear(),
      decor: unlocked.has('decor'),
      frame_user_ids: framed,
      hunt: Boolean(event.hunt?.enabled),
      goal: progress ? { total: progress.total, target: progress.target } : null,
    };
  }
  liveCache.set(db, { at: now, value });
  return value;
};

export const clearLiveCache = (db) => liveCache.delete(db);
