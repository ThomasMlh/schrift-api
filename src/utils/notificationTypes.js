// Canonical list of notification types sent to the Discord bot through notifyDiscord().
// Source of truth used to validate the notification settings payloads (guild and global).
export const NOTIFICATION_TYPES = [
  'scores',
  'podium_snapshot',
  'score_edit',
  'rotation_transfer',
  'character_update',
  'image_upload',
  'ban',
  'draft',
  'guild_toggle',
  'build_proposal',
  'build_delete',
  'cycle_change',
  'guild_change',
  'membre_role_change',
  'guild_member_change',
  'personal_record',
  'cycle_recap',
  'achievement_unlock',
];

export const isValidNotificationType = (type) => NOTIFICATION_TYPES.includes(type);

// Events only written to the activity log, never sent to Discord
export const ACTIVITY_ONLY_TYPES = ['album_update'];

export const isValidActivityType = (type) => isValidNotificationType(type) || ACTIVITY_ONLY_TYPES.includes(type);

export const sanitizeDisabledTypes = (input) =>
  Array.isArray(input) ? [...new Set(input.filter(isValidNotificationType))] : [];
