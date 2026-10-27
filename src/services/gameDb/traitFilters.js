/**
 * The game's own character filter: ability types grouped in categories (damage, abilities, items,
 * resistances, stats, battles). Stored at sync time so the site can offer the same filter.
 */
import { createDictionary } from './dictionary.js';

// An EX trait uses the ability type with an ex_ prefix
export const filterType = (type) => type.replace(/^ex_/, '');

const labelOf = (dict, type) => dict.text(`ui_sort_filter_${type}`) ?? dict.text(`lb_${type}`) ?? dict.text(`lb_attribute_tree_${type}`) ?? { fr: type };

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
