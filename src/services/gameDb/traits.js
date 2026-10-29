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

// Durations are stored in milliseconds (10000 = 10 s, not a reference), their texts are in seconds
const isDuration = (type) => /_up_time$|_time_up$|^team_battle_invincible$/.test(type);
const displayValue = (type, value) => (isDuration(type) && Number(value) ? Number(value) / 1000 : value);

// Text with its value: some "_with_value" texts have no {value} placeholder, the value is then appended
const textWithValue = (dict, key, value, suffix) => {
  const filled = dict.text(key, { value });
  if (!filled || !suffix || JSON.stringify(filled) !== JSON.stringify(dict.text(key))) return filled;
  return withValue(filled, suffix);
};

// Short name the game uses in its own filters, known for every ability type
export const filterLabel = (dict, type) => dict.text(`ui_sort_filter_${type}`);

export const abilityText = (dict, type, rawValue) => {
  if (!isDuration(type) && isReference(dict, type, rawValue)) return dict.text(`${type}_${rawValue}`);
  // An id without a dedicated text: the ability name alone
  const value = !isDuration(type) && Number(rawValue) >= REFERENCE_MIN ? null : displayValue(type, rawValue);
  if (hasValue(value)) {
    // Only durations get their value appended: other values without placeholder are flags (1) or hidden settings
    const suffix = isDuration(type) ? `(+${value}\u00a0s)` : null;
    for (const key of [`lb_${type}_with_value`, `lb_other_quests_${type}_with_value`, `lb_${type}_game_ui`]) {
      if (dict.has(key)) return textWithValue(dict, key, value, suffix);
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

// Stat boosts given by an ability (m_ability_status_up_give_abnormality), e.g. "Ascendance spirituelle (+90 %)"
const statusUpText = (dict, rows, value) => {
  const texts = rows.map((row) => dict.text(`${row.description}_game_ui`, { value: value ?? row.effect_amount }) ?? dict.text(row.description)).filter(Boolean);
  if (texts.length === 0) return null;
  return Object.fromEntries(Object.keys(texts[0]).map((lang) => [lang, texts.map((t) => t[lang]).filter(Boolean).join(' / ')]));
};

// Ability limited to some enemies or allies (m_ability_regist_belong_attribute): its own text, value in percent
const belongAttributeText = (dict, row, shown) => {
  const key = `lb_${row.description}_with_value`;
  return (dict.has(key) ? textWithValue(dict, key, shown, `(+${shown}\u00a0%)`) : null)
    ?? withValue(dict.text(row.description), `(+${shown}\u00a0%)`);
};

// Ability node of the soul tree (m_soul_piece); statusUps: m_ability_status_up_give_abnormality rows by group_id,
// belongAttributes: m_ability_regist_belong_attribute rows by id
export const treeTrait = (dict, type, value, statusUps = new Map(), belongAttributes = new Map()) => {
  const ref = !isDuration(type) && Number(value) >= REFERENCE_MIN ? String(value) : null;
  const belong = ref ? belongAttributes.get(ref) : null;
  if (belong) {
    const amount = numberOrNull(belong.parameter);
    return { kind: 'tree', type, value: amount, ref, text: belongAttributeText(dict, belong, amount) };
  }
  const text = (ref && statusUps.has(ref) ? statusUpText(dict, statusUps.get(ref)) : null) ?? abilityText(dict, type, value);
  return { kind: 'tree', type, value: ref ? null : numberOrNull(value), ref, text };
};

// Elimination bonus (m_destruction_bonus): unlocked after a number of enemies defeated in a quest
export const destructionTrait = (dict, row) => {
  const value = numberOrNull(row.view_parameter);
  return {
    kind: 'destruction',
    type: row.type,
    value,
    count: numberOrNull(row.destruction_count),
    text: (hasValue(value) ? dict.text(`${row.description}_with_value`, { value }) : null) ?? dict.text(row.description) ?? abilityText(dict, row.type, value),
  };
};

// Soul trait shared through links (soullink_ texts): the effect is shown, its name kept aside
export const linkTrait = (dict, type, value) => ({
  kind: 'link',
  type,
  value: numberOrNull(value),
  name: dict.text(`soullink_${type}`),
  text: (hasValue(value) ? dict.text(`soullink_${type}_with_value`, { value }) : null) ?? abilityText(dict, type, value) ?? dict.text(`soullink_${type}`),
});

// EX soul trait (m_extra_ability): one value per level 1-5, the text is the ability without its ex_ prefix
export const extraTrait = (dict, row, statusUps = new Map(), belongAttributes = new Map()) => {
  const type = row.type.replace(/^ex_/, '');
  const levels = [1, 2, 3, 4, 5].map((level) => row[`level${level}_parameter`]).filter((v) => v !== '');
  const max = levels[levels.length - 1];
  // Each level points to its own stat boost: one text with the boost of every level
  if (levels.length > 0 && levels.every((level) => statusUps.get(level)?.length === 1)) {
    const values = levels.map((level) => Number(statusUps.get(level)[0].effect_amount));
    const shown = new Set(values).size === 1 ? values[0] : values.join(' > ');
    return { kind: 'ex', type: row.type, values, ref: String(max), text: statusUpText(dict, statusUps.get(max), shown) };
  }
  // Each level points to its own limited ability: one text with the value of every level
  if (levels.length > 0 && levels.every((level) => belongAttributes.has(level))) {
    const values = levels.map((level) => Number(belongAttributes.get(level).parameter));
    const shown = new Set(values).size === 1 ? values[0] : values.join(' > ');
    return { kind: 'ex', type: row.type, values, ref: String(max), text: belongAttributeText(dict, belongAttributes.get(max), shown) };
  }
  if (isReference(dict, type, max)) return { kind: 'ex', type: row.type, values: null, ref: String(max), text: dict.text(`${type}_${max}`) };
  const values = levels.map(Number);
  const shown = new Set(values).size === 1 ? values[0] : values.join(' > ');
  return { kind: 'ex', type: row.type, values, text: abilityText(dict, type, shown) };
};
