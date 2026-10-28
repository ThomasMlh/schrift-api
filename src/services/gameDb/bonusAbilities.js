/**
 * Bonus abilities of the game (m_bonus_ability_slot): the bonus skills of a build, stored in the
 * `skills` collection and keyed by their game id. Value at the strength the game shows them.
 */
import { PRIMARY_LANGUAGE } from './source.js';

// "Permanence\nBattles seulement" -> "Permanence (Battles seulement)"
const oneLine = (text) => {
  const [first, ...rest] = text.replace(/\u00a0/g, ' ').split('\n').map((part) => part.trim()).filter(Boolean);
  return rest.length > 0 ? `${first} (${rest.join(' ')})` : first;
};

const FORMATS = new Set(['percent', 'plus']);

export const buildBonusAbilities = (tables, dict) => tables.m_bonus_ability_slot.map((row) => {
  const raw = dict.text(row.description, {}, '\n') ?? {};
  const names = Object.fromEntries(Object.entries(raw).filter(([, text]) => text).map(([language, text]) => [language, oneLine(text)]));
  const value = Number(row.view_parameter);
  return {
    game_id: Number(row.id),
    game_type: row.type,
    name: names[PRIMARY_LANGUAGE] ?? Object.values(names)[0] ?? row.type,
    names,
    // Shown next to the name: "15 %" for percent, "+200" for plus, nothing otherwise
    value: FORMATS.has(row.format) && value ? value : null,
    format: FORMATS.has(row.format) ? row.format : null,
    sort_order: Number(row.sort_order_bonus_ability_filter) || null,
  };
});

// Skills entered on the site before the game data: replaced, removed once
const legacyFilter = { game_id: { $exists: false } };

export const bonusAbilityChanges = async (db, abilities) => {
  const known = new Set(await db.collection('skills').distinct('game_id', { game_id: { $exists: true } }));
  return {
    skills: abilities.length,
    newSkills: abilities.filter((a) => !known.has(a.game_id)).length,
    legacySkills: await db.collection('skills').countDocuments(legacyFilter),
  };
};

// Upserts by game id, so the ids builds point to never change
export const saveBonusAbilities = async (db, abilities, now = new Date()) => {
  await db.collection('skills').deleteMany(legacyFilter);
  if (abilities.length === 0) return;
  await db.collection('skills').bulkWrite(abilities.map((ability) => ({
    updateOne: {
      filter: { game_id: ability.game_id },
      update: { $set: { ...ability, game_synced_at: now }, $setOnInsert: { created_at: now } },
      upsert: true,
    },
  })), { ordered: false });
};
