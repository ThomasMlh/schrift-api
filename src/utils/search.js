// Letters that match their accented forms in a search
const ACCENTED = {
  a: 'aàâä', e: 'eéèêë', i: 'iîï', o: 'oôö', u: 'uùûü', c: 'cç', y: 'yÿ',
};

/**
 * Regex source matching a searched text whatever its accents: "saisonnie" also finds "saisonnière".
 * Characters other than letters, digits and spaces are dropped, so the result is safe in a $regex.
 */
export const accentInsensitive = (search) => String(search ?? '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^\w\s]/g, '')
  .trim()
  .split('')
  .map((char) => (ACCENTED[char] ? `[${ACCENTED[char]}]` : char))
  .join('');
