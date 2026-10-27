/**
 * Builds the site characters from the game master tables. Pure: the tables are loaded by the caller.
 * One character per 6★ unit; its resurrected form, when the game has one, is stored inside it.
 */
import { createDictionary } from './dictionary.js';
import { extraTrait, linkTrait, passiveTrait, treeTrait } from './traits.js';
import { filterType } from './traitFilters.js';

export const GAME_TABLES = [
  'm_character',
  'm_dictionary',
  'm_resource_3d',
  'm_passive_ability',
  'm_extra_ability',
  'm_soul_piece',
  'm_character_attack',
  'm_character_resurrect_map',
  'm_character_filter_type',
  'm_character_filter_category',
  'm_ability_status_up_give_abnormality',
];

const AFFINITIES = { 1: 'Technique', 2: 'Instinct', 3: 'Force', 4: 'Vitesse', 5: 'Connaissance' };

// Killer and category names as the site already stores them
const BELONG_TYPES = {
  captain: 'Capitaine',
  espadas: 'Espada',
  hollow: 'Hollow',
  arrancar: 'Arrancar',
  soul_reaper: 'Shinigami',
  human: 'Humain',
  quincy: 'Quincy',
  stern_ritter: 'Stern Ritter',
  squad_zero: 'Division 0',
  neutral: 'Aucun',
};

// Game stat names -> site stat names (end = stamina, pre = spiritual pressure, cct = focus)
const STATS = { hp: 'end', atk: 'atk', def: 'def', crt: 'cct', sp: 'pre' };
const TIERS = ['init', 'first_max', 'second_max', 'third_max'];
const LISTED_CATEGORIES = new Set(['normal', 'growth_event']);
const ATTACK_GROUPS = ['normal', 'heavy1', 'heavy2', 'heavy3', 'ex', 'extra_action'];
const ATTACK_COLORS = { red: 'R', blue: 'B' };

const groupBy = (rows, key) => {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key]).push(row);
  }
  return map;
};

const killerName = (type) => {
  if (!type) return null;
  const plus = type.endsWith('_plus');
  const base = BELONG_TYPES[plus ? type.slice(0, -'_plus'.length) : type];
  return base ? `${base}${plus ? ' +' : ''}` : null;
};

// "2025-08-31 16:00:00" -> "31/08/2025", like the dates the site already stores
const gameDate = (raw) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw || '');
  return match && match[1] !== '0000' ? `${match[3]}/${match[2]}/${match[1]}` : null;
};

const tierStats = (row, tier) => {
  const values = Object.fromEntries(Object.entries(STATS).map(([game, site]) => [site, Number(row[`${tier}_${game}`])]));
  return Object.values(values).some((v) => v > 0) ? values : null;
};

// Explicit attack color of the first attack that has one, null when the game leaves it empty
const attackType = (row, attacksByGroup) => {
  for (const group of ATTACK_GROUPS) {
    for (const attack of attacksByGroup.get(row[`m_character_attack_group_id_${group}`]) ?? []) {
      if (ATTACK_COLORS[attack.atk_color]) return ATTACK_COLORS[attack.atk_color];
    }
  }
  return null;
};

const textOf = (texts) => (texts ? texts.fr ?? Object.values(texts)[0] ?? null : null);

export const buildCharacters = (tables, dict = createDictionary(tables.m_dictionary)) => {
  const resources = new Map(tables.m_resource_3d.map((r) => [r.id, r]));
  const passives = groupBy(tables.m_passive_ability, 'group_id');
  const extras = new Map(tables.m_extra_ability.map((r) => [r.id, r]));
  const soulTrees = groupBy(tables.m_soul_piece, 'pattern_id');
  const attacksByGroup = groupBy(tables.m_character_attack, 'group_id');
  const statusUps = groupBy(tables.m_ability_status_up_give_abnormality ?? [], 'group_id');
  const characterRows = new Map(tables.m_character.map((r) => [r.id, r]));
  const resurrectionOf = new Map(tables.m_character_resurrect_map.map((r) => [r.before_m_character_id, r.after_m_character_id]));

  // Stats at the last tier plus the stat nodes of the soul tree; abilities of the tree become traits
  const unitDetails = (row) => {
    const tree = soulTrees.get(row.m_soul_piece_pattern_id) ?? [];
    const treeStats = Object.fromEntries(Object.values(STATS).map((site) => [site, 0]));
    const treeAbilities = new Map();
    // The soul trait is split across nodes unlocked at each tier: the game shows their sum
    const link = new Map();
    for (const node of tree) {
      for (const [type, value] of [[node.type, node.parameter], [node.type2, node.parameter2]]) {
        if (!type || type === 'max_level') continue;
        if (STATS[type]) treeStats[STATS[type]] += Number(value) || 0;
        else if (node.is_link_skill === '1') link.set(type, (link.get(type) ?? 0) + (Number(value) || 0));
        else {
          const key = `${node.node_id}|${type}`;
          const previous = treeAbilities.get(key);
          treeAbilities.set(key, { type, value: previous && Number(value) ? String(Number(previous.value) + Number(value)) : value });
        }
      }
    }

    const tiers = Object.fromEntries(TIERS.map((tier) => [tier, tierStats(row, tier)]));
    const maxTier = tiers.third_max ?? tiers.second_max ?? tiers.first_max;
    const stats = maxTier ? Object.fromEntries(Object.entries(maxTier).map(([key, v]) => [key, v + treeStats[key]])) : null;

    const traits = {
      link: [...link].map(([type, value]) => linkTrait(dict, type, value)),
      passive: (passives.get(row.m_passive_ability_group_id) ?? []).map((p) => passiveTrait(dict, p)),
      tree: [...treeAbilities.values()].map(({ type, value }) => treeTrait(dict, type, value, statusUps)),
      ex: [row.m_extra_ability_id1, row.m_extra_ability_id2].filter((id) => extras.has(id)).map((id) => extraTrait(dict, extras.get(id), statusUps)),
    };
    return {
      game_id: Number(row.id),
      release_date: gameDate(row.start_date),
      stats,
      stats_tiers: { ...tiers, soul_tree: treeStats },
      traits,
    };
  };

  return tables.m_character
    .filter((row) => row.rarity === '6' && row.is_resurrect === '0' && LISTED_CATEGORIES.has(row.character_category))
    .map((row) => {
      const resource = resources.get(row.resource_3d_id);
      const names = dict.text(row.full_name) ?? dict.text(row.name);
      const resurrectedRow = characterRows.get(resurrectionOf.get(row.id));
      const details = unitDetails(row);
      const resurrection = resurrectedRow ? unitDetails(resurrectedRow) : null;
      const allTraits = [details.traits, resurrection?.traits].filter(Boolean).flatMap((t) => [...t.passive, ...t.tree, ...t.ex, ...t.link]);

      return {
        ...details,
        // The site shows the strongest form: resurrected stats when the unit has one
        stats: resurrection?.stats ?? details.stats,
        base_stats: details.stats,
        resource_2d_id: row.resource_2d_id || null,
        identity: row.chara_identity_id || null,
        name: textOf(names) ?? `#${row.id}`,
        names,
        short_names: dict.text(row.name),
        game_version: dict.text(row.variation),
        affinity: AFFINITIES[row.character_element] ?? null,
        attack_type: attackType(row, attacksByGroup),
        killers: [row.killer_type1, row.killer_type2].map(killerName).filter(Boolean),
        categories: [...new Set([resource?.belong_type_1, resource?.belong_type_2].map((t) => BELONG_TYPES[t]).filter(Boolean))],
        is_growth_event: row.character_category === 'growth_event',
        special: dict.text(`extra_attack_information_${row.id}`),
        profile: dict.text(row.profile),
        filter_types: [...new Set(allTraits.map((t) => filterType(t.type)))],
        resurrection,
      };
    });
};
