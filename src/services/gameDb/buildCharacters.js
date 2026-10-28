/**
 * Builds the site characters from the game master tables. Pure: the tables are loaded by the caller.
 * One character per 6★ unit; its resurrected form, when the game has one, is stored inside it.
 */
import { createDictionary } from './dictionary.js';
import { destructionTrait, extraTrait, linkTrait, passiveTrait, treeTrait } from './traits.js';
import { filterType } from './traitFilters.js';
import { animationHits, buildAttacks } from './attacks.js';

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
  'm_attack_collision',
  'm_gacha',
  'm_gacha_group',
  'm_gacha_layout',
  'm_destruction_bonus',
  'm_character_filter',
  'm_accessory',
  'm_accessory_effect',
  'm_accessory_second_effect_lot_stop_type',
  'm_constant',
  'm_bonus_ability_slot',
  'm_character_effect_priority',
];

// Tables the sync reads when present: attack_hits is extracted from the model bundles (tools/attack-hits)
export const OPTIONAL_GAME_TABLES = ['attack_hits'];

export const AFFINITIES = { 1: 'Technique', 2: 'Instinct', 3: 'Force', 4: 'Vitesse', 5: 'Connaissance' };

// Killer and category names as the site already stores them
export const BELONG_TYPES = {
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

// Red or blue attacks: a blue attack makes the unit blue, then a red one red; old units have no color
// set, their normal attacks decide (ranged = blue, melee = red), like the game shows them
const RANGED = '2';
const attackType = (row, attacksByGroup, collisions) => {
  const attacks = ATTACK_GROUPS.flatMap((group) => attacksByGroup.get(row[`m_character_attack_group_id_${group}`]) ?? []);
  const colors = new Set(attacks.map((attack) => ATTACK_COLORS[attack.atk_color]).filter(Boolean));
  if (colors.has('B')) return 'B';
  if (colors.has('R')) return 'R';
  const ranges = new Set((attacksByGroup.get(row.m_character_attack_group_id_normal) ?? [])
    .map((attack) => collisions.get(attack.m_attack_collision_id)?.range_type)
    .filter(Boolean));
  if (ranges.size === 0) return null;
  return ranges.size === 1 && ranges.has(RANGED) ? 'B' : 'R';
};

const textOf = (texts) => (texts ? texts.fr ?? Object.values(texts)[0] ?? null : null);

export const buildCharacters = (tables, dict = createDictionary(tables.m_dictionary)) => {
  const resources = new Map(tables.m_resource_3d.map((r) => [r.id, r]));
  const passives = groupBy(tables.m_passive_ability, 'group_id');
  const extras = new Map(tables.m_extra_ability.map((r) => [r.id, r]));
  const soulTrees = groupBy(tables.m_soul_piece, 'pattern_id');
  const attacksByGroup = groupBy(tables.m_character_attack, 'group_id');
  const statusUps = groupBy(tables.m_ability_status_up_give_abnormality ?? [], 'group_id');
  const collisions = new Map((tables.m_attack_collision ?? []).map((r) => [r.id, r]));
  const hitsByModel = groupBy(tables.attack_hits ?? [], 'resource_3d_id');
  const gachas = new Map((tables.m_gacha ?? []).map((r) => [r.id, r]));
  const gachaGroups = new Map((tables.m_gacha_group ?? []).map((r) => [r.id, r]));
  const layoutsByUnit = groupBy(tables.m_gacha_layout ?? [], 'content_id');
  const destructionBonuses = groupBy(tables.m_destruction_bonus ?? [], 'group_id');
  // Display order of the abilities in the game, highest first; types it does not list keep their place at the end
  const effectPriority = new Map((tables.m_character_effect_priority ?? []).map((r) => [r.type, Number(r.priority) || 0]));
  const byPriority = (traits) => [...traits].sort((a, b) => (effectPriority.get(b.type) ?? -1) - (effectPriority.get(a.type) ?? -1));

  // Kinds of special attack, as the game's "special effects" filter groups them
  const filled = (value) => Boolean(value) && value !== '0';
  const specialEffects = (row) => {
    const ex = attacksByGroup.get(row.m_character_attack_group_id_ex) ?? [];
    const effects = {
      barrier: ex.some((a) => filled(a.barrier_effect_id)),
      buff: ex.some((a) => filled(a.buff_target_type)),
      heal: ex.some((a) => filled(a.heal_type)),
      revival: ex.some((a) => filled(a.revival_id)),
      gauge: filled(row.boost_gauge_trigger) || filled(row.m_boost_gauge_ability_group_id),
      debuff_floor: ex.some((a) => filled(a.trap_attack_id)),
      common_extra_attack: filled(row.m_character_attack_group_id_extra_action),
      field_effect: filled(row.m_field_effect_group_id),
      attack_chain_action_enhance: filled(row.m_character_attack_chain_action_enhance_id),
    };
    return Object.keys(effects).filter((key) => effects[key]);
  };

  // Summons featuring the unit, oldest first
  const bannersOf = (gameId) => {
    const layouts = layoutsByUnit.get(gameId) ?? [];
    const byGroup = new Map();
    for (const layout of layouts) {
      if (byGroup.has(layout.m_gacha_group_id)) continue;
      const gacha = gachas.get(layout.m_gacha_id);
      byGroup.set(layout.m_gacha_group_id, {
        gacha_group_id: Number(layout.m_gacha_group_id),
        name: dict.text(gachaGroups.get(layout.m_gacha_group_id)?.name),
        // Rectangle visual of the summon list, in the localized rmfs folder (not every one is in the files)
        image_path: gachaGroups.get(layout.m_gacha_group_id)?.list_view_img_path ? `Localize/${gachaGroups.get(layout.m_gacha_group_id).list_view_img_path}` : null,
        start_date: gameDate(gacha?.start_date),
        end_date: gameDate(gacha?.end_date),
        sortKey: gacha?.start_date ?? '',
      });
    }
    return [...byGroup.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey)).map(({ sortKey: _sortKey, ...banner }) => banner);
  };
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
      link: byPriority([...link].map(([type, value]) => linkTrait(dict, type, value))),
      passive: byPriority((passives.get(row.m_passive_ability_group_id) ?? []).map((p) => passiveTrait(dict, p))),
      tree: byPriority([...treeAbilities.values()].map(({ type, value }) => treeTrait(dict, type, value, statusUps))),
      ex: byPriority([row.m_extra_ability_id1, row.m_extra_ability_id2].filter((id) => extras.has(id)).map((id) => extraTrait(dict, extras.get(id), statusUps))),
      destruction: (destructionBonuses.get(row.m_destruction_bonus_group_id) ?? [])
        .sort((a, b) => Number(a.destruction_count) - Number(b.destruction_count))
        .map((bonus) => destructionTrait(dict, bonus)),
    };
    return {
      game_id: Number(row.id),
      special_effects: specialEffects(row),
      attacks: buildAttacks(dict, row, attacksByGroup, collisions, animationHits(hitsByModel.get(row.resource_3d_id))),
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
      const units = [details, resurrection].filter(Boolean);
      const allTraits = units.flatMap(({ traits }) => [...traits.passive, ...traits.tree, ...traits.ex, ...traits.link]);
      const typesOf = (pick) => [...new Set(units.flatMap((unit) => pick(unit.traits).map((t) => filterType(t.type))))];

      return {
        ...details,
        // The site shows the strongest form: resurrected stats when the unit has one
        stats: resurrection?.stats ?? details.stats,
        base_stats: details.stats,
        resource_2d_id: row.resource_2d_id || null,
        // Order of the game's character book, higher = more recent: sorts units released the same day
        book_order: Number(row.book_order) || null,
        identity: row.chara_identity_id || null,
        name: textOf(names) ?? `#${row.id}`,
        names,
        short_names: dict.text(row.name),
        game_version: dict.text(row.variation),
        affinity: AFFINITIES[row.character_element] ?? null,
        attack_type: attackType(row, attacksByGroup, collisions),
        killers: [row.killer_type1, row.killer_type2].map(killerName).filter(Boolean),
        categories: [...new Set([resource?.belong_type_1, resource?.belong_type_2].map((t) => BELONG_TYPES[t]).filter(Boolean))],
        is_growth_event: row.character_category === 'growth_event',
        special: dict.text(`extra_attack_information_${row.id}`),
        quote: dict.text(row.gacha_message_dict_key),
        banners: bannersOf(row.id),
        profile: dict.text(row.profile),
        filter_types: [...new Set(allTraits.map((t) => filterType(t.type)))],
        // Same groups as the game's filter, both forms included
        filters: {
          link: typesOf((t) => t.link),
          ex: typesOf((t) => t.ex),
          skill: typesOf((t) => [...t.passive, ...t.tree]),
          special: [...new Set(units.flatMap((unit) => unit.special_effects))],
          destruction: typesOf((t) => t.destruction),
        },
        resurrection,
      };
    });
};
