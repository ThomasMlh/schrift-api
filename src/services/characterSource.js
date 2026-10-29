/**
 * Search names of the characters: the key the bot file (database.json) and the site share.
 */
// The source file writes empty cells as null, "", "  " or the string "null"
export const nullable = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' || trimmed.toLowerCase() === 'null' ? null : trimmed;
  }
  return value;
};

export const toSearchName = (raw) => (nullable(raw) ? String(raw).replace(/[^\w\sàâäéèêëïîôöùûüÿç]/g, '').trim() : '');
