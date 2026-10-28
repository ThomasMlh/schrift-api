/**
 * Game texts (m_dictionary): one column per language. A dump only fills the language of the client
 * it was taken from, so every text is an object holding the languages that are present.
 */
export const LANGUAGES = ['fr', 'en', 'ja', 'ko', 'th', 'sc', 'tc'];

// The game writes markup in brackets: [nbsp], [sup]e[/sup], [ff0000]colors[-]...
export const cleanMarkup = (text) => text
  .replace(/\[nbsp\]/g, ' ')
  .replace(/\[\/?[a-z0-9-]*\]/gi, '')
  .replace(/[ \t]*\n[ \t]*/g, ' ')
  .trim();

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (match, name) => (values[name] ?? match));

// translations: dictionaries dumped from clients in other languages, they only add the languages missing
export const createDictionary = (rows, translations = []) => {
  const byKey = new Map();
  for (const source of [rows, ...translations.map((t) => t.rows)]) {
    for (const row of source) {
      const texts = byKey.get(row.dictkey) ?? {};
      for (const lang of LANGUAGES) if (row[`content_${lang}`] && !texts[lang]) texts[lang] = row[`content_${lang}`];
      if (Object.keys(texts).length > 0) byKey.set(row.dictkey, texts);
    }
  }

  const languages = LANGUAGES.filter((lang) => [...byKey.values()].some((texts) => texts[lang]));

  // { fr: '...', en: '...' } with placeholders filled, or null when the key is unknown
  const text = (key, values = {}) => {
    const texts = key ? byKey.get(key) : null;
    if (!texts) return null;
    return Object.fromEntries(Object.entries(texts).map(([lang, raw]) => [lang, cleanMarkup(fill(raw, values))]));
  };

  const has = (key) => byKey.has(key);

  return { text, has, languages };
};
