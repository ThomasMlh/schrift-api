/**
 * The game's own character filter: ability types grouped in categories (damage, abilities, items,
 * resistances, stats, battles). Stored at sync time so the site can offer the same filter.
 */
import { createDictionary } from './dictionary.js';

// An EX trait uses the ability type with an ex_ prefix
export const filterType = (type) => type.replace(/^ex_/, '');

// Where the game names an ability type, the filter names first: passive and accessory filters, the
// category/affinity filter the affinity-only types belong to, then the ability, soul link and link texts
const LABEL_KEYS = [
  (type) => `ui_sort_filter_${type}`,
  (type) => `ui_sort_filter_passive_${type}`,
  (type) => `ui_sort_filter_acce_effect_${type}`,
  (type) => `ui_sort_filter_${type.replace(/^attribute_/, 'belong_')}`,
  (type) => `lb_${type}`,
  (type) => `lb_attribute_tree_${type}`,
  (type) => `lb_effect_${type}`,
  (type) => `soullink_${type}`,
  (type) => `lb_character_link_${type}`,
];

// A text written on two lines in the game: "Effet tueur augmenté\nQuêtes de groupe" -> "Effet tueur augmenté (Quêtes de groupe)"
const oneLine = (text) => {
  const [first, ...rest] = text.split('\n').map((part) => part.trim()).filter(Boolean);
  return rest.length > 0 ? `${first} (${rest.join(' ')})` : first;
};

export const labelOf = (dict, type) => {
  for (const key of LABEL_KEYS) {
    const text = dict.text(key(type), {}, '\n');
    if (text) return Object.fromEntries(Object.entries(text).map(([lang, value]) => [lang, oneLine(value)]));
  }
  return { fr: type };
};

// Kinds of special attack (barrier, heal...) and elimination bonuses, with the game's filter names
export const buildSpecialFilters = (tables, dict = createDictionary(tables.m_dictionary)) => (tables.m_character_filter ?? [])
  .filter((row) => row.usage_type === 'ui_sort_filter_sp_attack_category_type')
  .sort((a, b) => Number(a.sort_order) - Number(b.sort_order))
  .map((row) => ({ type: row.description, label: dict.text(`ui_sort_filter_${row.description}`) ?? { fr: row.description } }));

export const buildDestructionFilters = (tables, dict = createDictionary(tables.m_dictionary)) => {
  const types = [...new Set((tables.m_destruction_bonus ?? []).map((row) => row.type))];
  return types.map((type) => ({ type, label: dict.text(`ui_sort_filter_destruction_${type}`) ?? labelOf(dict, type) }));
};

export const buildTraitFilters = (tables, dict = createDictionary(tables.m_dictionary)) => {
  const types = tables.m_character_filter_type;
  return tables.m_character_filter_category
    .map((category) => ({
      id: Number(category.id),
      label: dict.text(category.description) ?? { fr: category.description },
      priority: Number(category.priority) || 0,
      types: types
        .filter((t) => t.m_character_filter_category_id === category.id)
        .sort((a, b) => Number(b.priority) - Number(a.priority))
        .map((t) => ({ type: t.type, label: labelOf(dict, t.type) })),
    }))
    .filter((category) => category.types.length > 0)
    .sort((a, b) => b.priority - a.priority);
};
