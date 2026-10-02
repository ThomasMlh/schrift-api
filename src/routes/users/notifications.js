import { ObjectId } from 'mongodb';
import { notifyDiscord } from '../../utils/notifyDiscord.js';
import { getUserDisplayName } from '../../utils/nameMatching.js';

// Partagé entre crud.js (PATCH /:userId) et roles.js (PUT /:userId/guild) :
// les deux routes peuvent changer la guilde du compte PRINCIPAL d'un user.
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

// Notifie un join/leave de guilde pour UN compte bbs précis (utilisé par les routes /accounts/*,
// qui portent la vraie logique d'édition guilde/rôle depuis EditUserModal — contrairement à
// notifyGuildChange ci-dessus qui ne cible que le compte principal).
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

// Notifie un changement de rôle pour UN compte bbs précis (guilde inchangée).
export const notifyAccountRoleChange = async (db, { username, guildeId, oldRole, newRole }) => {
  const guilde = guildeId ? await db.collection('guildes').findOne({ _id: new ObjectId(guildeId) }) : null;
  await notifyDiscord('membre_role_change', {
    membre_name: username,
    guild_name: guilde?.name || '',
    old_role: oldRole || 'membre',
    new_role: newRole
  }, guilde?.discord_channel_id || process.env.DISCORD_CHANNEL_GLOBAL_CHEF);
};
