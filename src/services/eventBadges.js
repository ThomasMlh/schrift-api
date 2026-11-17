import { ObjectId } from 'mongodb';

// Limited edition badges: an event with a badge name gives it to every site account that took part
// in one of its activities while it ran (quiz finished, calendar case answered). Once the event is
// over nobody can earn it any more; a later event has its own badge.

const badges = (db) => db.collection('event_badges');

export const awardEventBadge = async (db, event, userId, via, now = new Date()) => {
  if (!event?.badge_name || !userId || now < event.start_at || now > event.end_at) return;
  await badges(db).updateOne(
    { event_id: event._id.toString(), user_id: String(userId) },
    { $setOnInsert: { earned_at: now, via } },
    { upsert: true },
  );
};

/** Badges of a site account, with how many accounts share each one. */
export const listUserBadges = async (db, userId) => {
  const owned = await badges(db).find({ user_id: String(userId) }).sort({ earned_at: 1 }).toArray();
  if (!owned.length) return [];
  const ids = owned.map((b) => b.event_id);
  const [events, counts] = await Promise.all([
    db.collection('events').find({ _id: { $in: ids.filter(ObjectId.isValid).map((id) => new ObjectId(id)) } }, { projection: { name: 1, badge_name: 1, start_at: 1, end_at: 1 } }).toArray(),
    badges(db).aggregate([{ $match: { event_id: { $in: ids } } }, { $group: { _id: '$event_id', holders: { $sum: 1 } } }]).toArray(),
  ]);
  const eventById = new Map(events.map((e) => [e._id.toString(), e]));
  const holders = new Map(counts.map((c) => [c._id, c.holders]));
  return owned
    .filter((b) => eventById.has(b.event_id))
    .map((b) => {
      const event = eventById.get(b.event_id);
      return {
        event_id: b.event_id,
        name: event.badge_name || event.name,
        event_name: event.name,
        year: new Date(event.start_at).getUTCFullYear(),
        earned_at: b.earned_at,
        holders: holders.get(b.event_id) ?? 1,
      };
    });
};

export const deleteEventBadges = (db, eventId) => badges(db).deleteMany({ event_id: eventId });
