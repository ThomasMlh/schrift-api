import { buildCharacters } from '../../src/services/gameDb/buildCharacters.js';

const stats = (prefix, [hp, sp, atk, def, crt]) => ({
  [`${prefix}_hp`]: String(hp), [`${prefix}_sp`]: String(sp), [`${prefix}_atk`]: String(atk), [`${prefix}_def`]: String(def), [`${prefix}_crt`]: String(crt),
});

const character = (overrides) => ({
  id: '61758',
  name: 'lb_cname_chr_NIN',
  full_name: 'lb_cname_chr_NIN_full',
  variation: 'lb_swim_ver',
  chara_identity_id: 'NIN',
  resource_2d_id: '1872',
  resource_3d_id: '0900_NIN_mdl',
  rarity: '6',
  character_category: 'normal',
  character_element: '3',
  is_resurrect: '0',
  ...stats('init', [212, 61, 45, 27, 32]),
  ...stats('first_max', [888, 600, 387, 157, 183]),
  ...stats('second_max', [952, 702, 498, 259, 304]),
  ...stats('third_max', [1155, 764, 593, 316, 359]),
  m_character_attack_group_id_normal: '1',
  killer_type1: 'arrancar_plus',
  killer_type2: '',
  m_soul_piece_pattern_id: '61758',
  m_passive_ability_group_id: '1758',
  m_extra_ability_id1: '617581',
  m_extra_ability_id2: '',
  profile: 'lb_profile_NIN',
  start_date: '2025-08-31 16:00:00',
  ...overrides,
});

const node = (nodeId, type, parameter, extra = {}) => ({
  pattern_id: '61758', node_id: String(nodeId), level: '1', type, parameter: String(parameter), type2: '', parameter2: '0', is_link_skill: '0', ...extra,
});

const tables = () => ({
  m_character: [
    character(),
    character({ id: '1758', rarity: '5', third_max_hp: '' }),
    character({ id: '81758', is_resurrect: '1', start_date: '2026-10-28 16:00:00', ...stats('third_max', [1200, 800, 600, 320, 360]), m_soul_piece_pattern_id: '81758' }),
    character({ id: '6030', character_category: 'advent' }),
  ],
  m_dictionary: [
    { dictkey: 'lb_cname_chr_NIN', content_fr: 'Ninny' },
    { dictkey: 'lb_cname_chr_NIN_full', content_fr: 'Ninny Spangcole' },
    { dictkey: 'lb_swim_ver', content_fr: 'version maillot' },
    { dictkey: 'lb_profile_NIN', content_fr: 'Une sorcière[nbsp]!' },
    { dictkey: 'lb_sp_atk_range_up_rate', content_fr: 'Attaques puissantes étendues' },
    { dictkey: 'lb_last_atk_dmg_up_rate_heavy_with_value', content_fr: 'Attaques puissantes renforcées (+{value}[nbsp]%)' },
    { dictkey: 'soullink_last_atk_dmg_up_rate_heavy', content_fr: 'Attaques puissantes dévastatrices' },
    { dictkey: 'lb_last_atk_dmg_up_rate_ex_with_value', content_fr: 'Attaque spéciale renforcée (+{value}[nbsp]%)' },
    { dictkey: 'lb_attack_bad_status_up_time_with_value', content_fr: 'Malédiction (+{value}[nbsp]s)' },
    { dictkey: 'belong_attribute_bad_status_probability_617581', content_fr: "Gêneur d'Arrancar" },
    { dictkey: 'ui_sort_filter_belong_bad_status_parameter_up', content_fr: 'Ascendance' },
    { dictkey: 'm_ability_sp_up_give_abnormality', content_fr: 'Ascendance spirituelle' },
    { dictkey: 'm_ability_sp_up_give_abnormality_game_ui', content_fr: 'Ascendance spirituelle (+{value}[nbsp]%)' },
    { dictkey: 'gacha_limited_576_name', content_fr: 'Loterie maillots' },
    { dictkey: 'gacha_limited_2385_name', content_fr: 'Loterie Burn the Witch' },
    { dictkey: 'extra_attack_information_61758', content_fr: 'Large attaque vers l\'avant.' },
  ],
  m_resource_3d: [{ id: '0900_NIN_mdl', belong_type_1: 'human', belong_type_2: 'quincy' }],
  m_passive_ability: [{ group_id: '1758', type: 'sp_atk_range_up_rate', view_parameter: '20.0', format: 'percent', description: 'lb_sp_atk_range_up_rate' }],
  m_extra_ability: [{ id: '617581', type: 'ex_last_atk_dmg_up_rate_ex', level1_parameter: '18', level2_parameter: '22', level3_parameter: '25', level4_parameter: '28', level5_parameter: '30' }],
  m_soul_piece: [
    node(0, 'last_atk_dmg_up_rate_heavy', 20, { is_link_skill: '1' }),
    node(25, 'last_atk_dmg_up_rate_heavy', 10, { is_link_skill: '1' }),
    node(1, 'last_atk_dmg_up_rate_heavy', 55),
    node(3, 'def', 4), node(3, 'def', 4, { level: '2' }),
    node(6, 'hp', 90), node(7, 'atk', 60), node(8, 'sp', 170), node(9, 'crt', 40), node(10, 'def', 32),
    node(16, 'belong_attribute_bad_status_probability', 617581),
    node(17, 'attack_bad_status_up_time', 5000),
    node(21, 'belong_bad_status_parameter_up', 61510),
    node(23, 'max_level', 2),
    { ...node(1, 'hp', 100), pattern_id: '81758' },
  ],
  m_character_attack: [{ group_id: '1', atk_color: 'red' }],
  m_character_resurrect_map: [{ before_m_character_id: '61758', after_m_character_id: '81758' }],
  m_gacha_layout: [
    { m_gacha_id: '23852', m_gacha_group_id: '2385', content_id: '61758' },
    { m_gacha_id: '5762', m_gacha_group_id: '576', content_id: '61758' },
    { m_gacha_id: '5761', m_gacha_group_id: '576', content_id: '61758' },
  ],
  m_gacha_group: [
    { id: '576', name: 'gacha_limited_576_name', list_view_img_path: 'bn_gacha_limited_576_sub' },
    { id: '2385', name: 'gacha_limited_2385_name', list_view_img_path: '' },
  ],
  m_gacha: [
    { id: '5762', start_date: '2025-08-31 16:00:00', end_date: '2025-09-14 15:59:59' },
    { id: '23852', start_date: '2026-08-31 16:00:00', end_date: '2026-09-14 15:59:59' },
  ],
  m_ability_status_up_give_abnormality: [{ group_id: '61510', status_up_type: 'sp', effect_amount: '90', description: 'm_ability_sp_up_give_abnormality' }],
});

describe('attack color', () => {
  const unit = (id, normalGroup, heavyGroup = '') => character({ id, m_character_attack_group_id_normal: normalGroup, m_character_attack_group_id_heavy1: heavyGroup });
  const colorOf = (units) => {
    const base = tables();
    const built = buildCharacters({
      ...base,
      m_character: units,
      m_character_attack: [
        { group_id: 'red', atk_color: 'red', m_attack_collision_id: 'melee' },
        { group_id: 'blue', atk_color: 'blue', m_attack_collision_id: 'melee' },
        { group_id: 'melee', atk_color: '', m_attack_collision_id: 'melee' },
        { group_id: 'ranged', atk_color: '', m_attack_collision_id: 'ranged' },
      ],
      m_attack_collision: [{ id: 'melee', range_type: '1' }, { id: 'ranged', range_type: '2' }],
    });
    return Object.fromEntries(built.map((c) => [c.game_id, c.attack_type]));
  };

  it('is blue as soon as one attack is blue, red otherwise when one is red', () => {
    expect(colorOf([unit('1', 'red', 'blue'), unit('2', 'red', 'melee')])).toEqual({ 1: 'B', 2: 'R' });
  });

  it('follows the range of the normal attacks when no attack has a color', () => {
    expect(colorOf([unit('3', 'ranged'), unit('4', 'melee'), unit('5', 'none')])).toEqual({ 3: 'B', 4: 'R', 5: null });
  });
});

describe('buildCharacters', () => {
  const [ninny, ...others] = buildCharacters(tables());

  it('keeps one character per 6★ unit, without 5★, resurrected or raid rows', () => {
    expect(others).toEqual([]);
    expect(ninny).toMatchObject({ game_id: 61758, resource_2d_id: '1872', identity: 'NIN', name: 'Ninny Spangcole' });
    expect(ninny.names).toEqual({ fr: 'Ninny Spangcole' });
    expect(ninny.short_names).toEqual({ fr: 'Ninny' });
    expect(ninny.game_version).toEqual({ fr: 'version maillot' });
    expect(ninny.profile).toEqual({ fr: 'Une sorcière !' });
  });

  it('maps affinity, killers, categories, attack color and release date to the site values', () => {
    expect(ninny).toMatchObject({
      affinity: 'Force',
      killers: ['Arrancar +'],
      categories: ['Humain', 'Quincy'],
      attack_type: 'R',
      release_date: '31/08/2025',
      is_growth_event: false,
    });
  });

  it('adds the stat nodes of the soul tree to the last stat tier', () => {
    expect(ninny.base_stats).toEqual({ end: 1245, atk: 653, def: 356, cct: 399, pre: 934 });
    expect(ninny.stats_tiers.soul_tree).toEqual({ end: 90, atk: 60, def: 40, cct: 40, pre: 170 });
  });

  it('reads the soul traits, the soul tree abilities, the EX traits and the link skill', () => {
    const texts = (list) => list.map((t) => t.text?.fr);
    expect(texts(ninny.traits.passive)).toEqual(['Attaques puissantes étendues (+20 %)']);
    expect(texts(ninny.traits.tree)).toEqual([
      'Attaques puissantes renforcées (+55 %)',
      "Gêneur d'Arrancar",
      'Malédiction (+5 s)',
      'Ascendance spirituelle (+90 %)',
    ]);
    expect(texts(ninny.traits.ex)).toEqual(['Attaque spéciale renforcée (+18 > 22 > 25 > 28 > 30 %)']);
    // Both soul trait nodes add up, like in the game
    expect(texts(ninny.traits.link)).toEqual(['Attaques puissantes renforcées (+30\u00a0%)']);
    expect(ninny.traits.link[0].name).toEqual({ fr: 'Attaques puissantes dévastatrices' });
    expect(ninny.special).toEqual({ fr: 'Large attaque vers l\'avant.' });
    expect(ninny.filter_types).toEqual(expect.arrayContaining(['sp_atk_range_up_rate', 'last_atk_dmg_up_rate_heavy', 'last_atk_dmg_up_rate_ex']));
  });

  it('lists the summons featuring the unit, oldest first, with their list visual', () => {
    expect(ninny.banners).toEqual([
      { gacha_group_id: 576, name: { fr: 'Loterie maillots' }, image_path: 'Localize/bn_gacha_limited_576_sub', start_date: '31/08/2025', end_date: '14/09/2025' },
      { gacha_group_id: 2385, name: { fr: 'Loterie Burn the Witch' }, image_path: null, start_date: '31/08/2026', end_date: '14/09/2026' },
    ]);
  });

  it('stores the resurrected form with its own stats and date', () => {
    expect(ninny.resurrection).toMatchObject({ game_id: 81758, release_date: '28/10/2026' });
    expect(ninny.resurrection.stats).toEqual({ end: 1300, atk: 600, def: 320, cct: 360, pre: 800 });
    // Like the site already did, the listed stats are the resurrected ones
    expect(ninny.stats).toEqual(ninny.resurrection.stats);
  });
});
