// Liste canonique des types de notification envoyés au bot Discord via notifyDiscord().
// Source de vérité utilisée pour valider les payloads de settings (guilde et global).
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
];

export const isValidNotificationType = (type) => NOTIFICATION_TYPES.includes(type);

export const sanitizeDisabledTypes = (input) =>
  Array.isArray(input) ? [...new Set(input.filter(isValidNotificationType))] : [];
