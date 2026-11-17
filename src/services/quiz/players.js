import { ObjectId } from 'mongodb';

/**
 * Adds to each row the site account shown with the player's avatar: `user` holds the Discord avatar
 * and the bbs account the activity was played under. Rows carry `user_id` (site account id, or the
 * Discord id of older tokens), `bbs_id` and `name`.
 */
export const withPlayers = async (db, rows) => {
  const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
  if (!ids.length) return rows;
  const users = await db.collection('users').find(
    { $or: [{ _id: { $in: ids.filter(ObjectId.isValid).map((id) => new ObjectId(id)) } }, { discord_id: { $in: ids } }] },
    { projection: { discord_id: 1, avatar: 1, global_name: 1 } },
  ).toArray();
  const byKey = new Map(users.flatMap((u) => [[u._id.toString(), u], [u.discord_id, u]]));
  return rows.map((row) => {
    const user = byKey.get(row.user_id);
    return {
      ...row,
      user: {
        _id: user?._id ?? null,
        discord_id: user?.discord_id ?? null,
        avatar: user?.avatar ?? null,
        global_name: user?.global_name ?? null,
        bbs_name: row.name,
        bbs_id: row.bbs_id ?? null,
      },
    };
  });
};
