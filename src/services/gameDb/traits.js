/**
 * Readable texts of character abilities. The game stores an ability as a type plus a value, the text
 * comes from m_dictionary under one of several key patterns depending on where the ability is shown.
 * Values above REFERENCE_MIN are ids of a dedicated text (e.g. attribute_damage_up_617582).
 */
const REFERENCE_MIN = 10000;

const isReference = (dict, type, value) => Number(value) >= REFERENCE_MIN && dict.has(`${type}_${value}`);

// "0" and empty cells mean the ability has no value to show
const hasValue = (value) => value !== undefined && value !== null && value !== '' && Number(value) !== 0;

const withValue = (text, suffix) => (text ? Object.fromEntries(Object.entries(text).map(([lang, t]) => [lang, `${t} ${suffix}`])) : null);

// Durations are stored in milliseconds, their texts are in seconds
const displayValue = (type, value) => (/_up_time$/.test(type) && Number(value) ? Number(value) / 1000 : value);

// Short name the game uses in its own filters, known for every ability type
export const filterLabel = (dict, type) => dict.text(`ui_sort_filter_${type}`);

export const abilityText = (dict, type, rawValue) => {
  if (isReference(dict, type, rawValue)) return dict.text(`${type}_${rawValue}`);
  // An id without a dedicated text: the ability name alone
  const value = Number(rawValue) >= REFERENCE_MIN ? null : displayValue(type, rawValue);
  if (hasValue(value)) {
    for (const key of [`lb_${type}_with_value`, `lb_other_quests_${type}_with_value`, `lb_${type}_game_ui`]) {
      if (dict.has(key)) return dict.text(key, { value });
    }
  }
  for (const key of [`lb_${type}`, `lb_attribute_tree_${type}`, `lb_attribute_tree_${type}_detail`]) {
    if (dict.has(key)) return hasValue(value) ? withValue(dict.text(key), `(${value})`) : dict.text(key);
  }
  return filterLabel(dict, type);
};

const numberOrNull = (value) => (value === '' || value === undefined || Number.isNaN(Number(value)) ? null : Number(value));

// Soul trait of the character (m_passive_ability), its description key is given
export const passiveTrait = (dict, row) => {
  const value = numberOrNull(row.view_parameter);
  const name = dict.text(row.description);
  const suffix = {
    percent: value ? `(+${value}\u00a0%)` : null,
    plus: value ? `+${value}` : null,
    interval: value ? `(${value / 1000}\u00a0s)` : null,
  }[row.format] ?? null;
  return { kind: 'passive', type: row.type, value, text: suffix ? withValue(name, suffix) : name };
};

// Ability node of the soul tree (m_soul_piece)
export const treeTrait = (dict, type, value) => {
  const ref = Number(value) >= REFERENCE_MIN ? String(value) : undefined;
  return { kind: 'tree', type, value: ref ? null : numberOrNull(value), ref, text: abilityText(dict, type, value) };
};

// Link skill: the soullink_ texts, name then effect
export const linkTrait = (dict, type, value) => {
  const name = dict.text(`soullink_${type}`);
  const effect = dict.text(`soullink_${type}_with_value`, { value }) ?? abilityText(dict, type, value);
  const text = name && effect
    ? Object.fromEntries(Object.entries(name).map(([lang, n]) => [lang, effect[lang] ? `${n} : ${effect[lang]}` : n]))
    : name ?? effect;
  return { kind: 'link', type, value: numberOrNull(value), text };
};

// EX soul trait (m_extra_ability): one value per level 1-5, the text is the ability without its ex_ prefix
export const extraTrait = (dict, row) => {
  const type = row.type.replace(/^ex_/, '');
  const levels = [1, 2, 3, 4, 5].map((level) => row[`level${level}_parameter`]).filter((v) => v !== '');
  const max = levels[levels.length - 1];
  if (isReference(dict, type, max)) return { kind: 'ex', type: row.type, values: null, ref: String(max), text: dict.text(`${type}_${max}`) };
  const values = levels.map(Number);
  const shown = new Set(values).size === 1 ? values[0] : values.join(' > ');
  return { kind: 'ex', type: row.type, values, text: abilityText(dict, type, shown) };
};
