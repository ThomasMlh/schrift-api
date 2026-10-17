import { ObjectId } from 'mongodb';
import { notifyDiscord } from '../../utils/notifyDiscord.js';
import { getUserDisplayName } from '../../utils/nameMatching.js';

// Shared by crud.js (PATCH /:userId) and roles.js (PUT /:userId/guild): both routes can change the
// guild of a user's MAIN account.
export const notifyGuildChange = async (db, userBefore, newGuildeId) => {
  const username = getUserDisplayName(userBefore);
  const oldGuildeId = userBefore.guilde_id || null;

  const [oldGuilde, newGuilde] = await Promise.all([
    oldGuildeId ? db.collection('guildes').findOne({ _id: new ObjectId(oldGuildeId) }) : null,
    newGuildeId ? db.collection('guildes').findOne({ _id: new ObjectId(newGuildeId) }) : null,
  ]);

  const oldGuildName = oldGuilde?.name || 'Aucune guilde';
  const newGuildName = newGuilde?.name || 'Aucune guilde';

  const promises = [];

  if (oldGuilde) {
    promises.push(notifyDiscord('draft', {
      guild_name: oldGuildName,
      moves: [{ username, fromGuildName: oldGuildName, toGuildName: newGuildName, direction: 'départ' }],
    }, oldGuilde.discord_channel_id || undefined));
  }

  if (newGuilde) {
    promises.push(notifyDiscord('draft', {
      guild_name: newGuildName,
      moves: [{ username, fromGuildName: oldGuildName, toGuildName: newGuildName, direction: 'arrivée' }],
    }, newGuilde.discord_channel_id || undefined));
  }

  await Promise.allSettled(promises);
};

// Notifies a guild join/leave for ONE bbs account (used by the /accounts/* routes, which hold the
// actual guild/role editing from EditUserModal; notifyGuildChange above only targets the main account).
export const notifyAccountGuildMove = async (db, { username, oldGuildeId, newGuildeId, role }) => {
  const [oldGuilde, newGuilde] = await Promise.all([
    oldGuildeId ? db.collection('guildes').findOne({ _id: new ObjectId(oldGuildeId) }) : null,
    newGuildeId ? db.collection('guildes').findOne({ _id: new ObjectId(newGuildeId) }) : null,
  ]);

  const promises = [];
  if (oldGuilde) {
    promises.push(notifyDiscord('guild_member_change', {
      action: 'leave', username, guild_name: oldGuilde.name
    }, oldGuilde.discord_channel_id || process.env.DISCORD_CHANNEL_GLOBAL_CHEF));
  }
  if (newGuilde) {
    promises.push(notifyDiscord('guild_member_change', {
      action: 'join', username, guild_name: newGuilde.name, role
    }, newGuilde.discord_channel_id || process.env.DISCORD_CHANNEL_GLOBAL_CHEF));
  }
  await Promise.allSettled(promises);
};

// Notifies a role change for ONE bbs account (same guild).
export const notifyAccountRoleChange = async (db, { username, guildeId, oldRole, newRole }) => {
  const guilde = guildeId ? await db.collection('guildes').findOne({ _id: new ObjectId(guildeId) }) : null;
  await notifyDiscord('membre_role_change', {
    membre_name: username,
    guild_name: guilde?.name || '',
    old_role: oldRole || 'membre',
    new_role: newRole
  }, guilde?.discord_channel_id || process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
};
