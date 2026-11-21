import { ObjectId } from 'mongodb';

// Limited edition badges: an event with a badge name gives it to every site account that took part
// in one of its activities while it ran (quiz finished, calendar case answered). Once the event is
// over nobody can earn it any more; a later event has its own badge.
// An event with a gift hunt can give a second badge to the players who found enough gifts: it is kept
// on the same document (hunter_at), since finding a gift already gives the first one.

const badges = (db) => db.collection('event_badges');

export const awardEventBadge = async (db, event, userId, via, now = new Date()) => {
  if (!event?.badge_name || !userId || now < event.start_at || now > event.end_at) return;
  await badges(db).updateOne(
    { event_id: event._id.toString(), user_id: String(userId) },
    { $setOnInsert: { earned_at: now, via } },
    { upsert: true },
  );
};

/** Hunter badge of the gift hunt; true when this call gave it. */
export const awardHunterBadge = async (db, event, userId, now = new Date()) => {
  if (!event?.hunt?.badge_name || !userId || now < event.start_at || now > event.end_at) return false;
  // The document exists already when the event has a participant badge
  await badges(db).updateOne(
    { event_id: event._id.toString(), user_id: String(userId) },
    { $setOnInsert: { earned_at: now, via: 'hunt' } },
    { upsert: true },
  );
  const result = await badges(db).updateOne(
    { event_id: event._id.toString(), user_id: String(userId), hunter_at: { $exists: false } },
    { $set: { hunter_at: now } },
  );
  return result.modifiedCount > 0;
};

/** Badges of a site account, with how many accounts share each one. */
export const listUserBadges = async (db, userId) => {
  const owned = await badges(db).find({ user_id: String(userId) }).sort({ earned_at: 1 }).toArray();
  if (!owned.length) return [];
  const ids = owned.map((b) => b.event_id);
  const [events, counts] = await Promise.all([
    db.collection('events').find({ _id: { $in: ids.filter(ObjectId.isValid).map((id) => new ObjectId(id)) } }, { projection: { name: 1, badge_name: 1, 'hunt.badge_name': 1, start_at: 1, end_at: 1 } }).toArray(),
    badges(db).aggregate([
      { $match: { event_id: { $in: ids } } },
      { $group: { _id: '$event_id', holders: { $sum: 1 }, hunters: { $sum: { $cond: [{ $ifNull: ['$hunter_at', false] }, 1, 0] } } } },
    ]).toArray(),
  ]);
  const eventById = new Map(events.map((e) => [e._id.toString(), e]));
  const countOf = new Map(counts.map((c) => [c._id, c]));
  return owned
    .filter((b) => eventById.has(b.event_id))
    .flatMap((b) => {
      const event = eventById.get(b.event_id);
      const base = { event_id: b.event_id, event_name: event.name, year: new Date(event.start_at).getUTCFullYear() };
      return [
        ...(event.badge_name ? [{
          ...base, kind: 'participant', name: event.badge_name, earned_at: b.earned_at, holders: countOf.get(b.event_id)?.holders ?? 1,
        }] : []),
        ...(b.hunter_at && event.hunt?.badge_name ? [{
          ...base, kind: 'hunter', name: event.hunt.badge_name, earned_at: b.hunter_at, holders: countOf.get(b.event_id)?.hunters ?? 1,
        }] : []),
      ];
    });
};

export const deleteEventBadges = (db, eventId) => badges(db).deleteMany({ event_id: eventId });
