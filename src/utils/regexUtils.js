// Escapes regex metacharacters in user-provided text before using it in a MongoDB $regex.
// Otherwise a name like "[FR]Whitep" or "(Nun)" is read as a pattern (character class / group)
// instead of literal text, and matches nothing.
export const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
