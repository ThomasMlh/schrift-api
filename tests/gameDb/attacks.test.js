import { animationHits, applyAttackBonuses, attackShape, buildAttacks, parseStatuses, trapOf, widenShape } from '../../src/services/gameDb/attacks.js';
import { createDictionary } from '../../src/services/gameDb/dictionary.js';

const dict = createDictionary([
  { dictkey: 'lb_status_effect_type_wek', content_fr: 'Faiblesse' },
  { dictkey: 'ui_common_resitance_erosion', content_fr: 'Érosion' },
]);

describe('attacks', () => {
  it('reads combined and "+" statuses', () => {
    expect(parseStatuses(dict, 'Wek&Ero_Plus', '0&2', '3000')).toEqual([
      { code: 'wek', plus: false, name: { fr: 'Faiblesse' }, probability: 0, duration: 3000 },
      { code: 'ero', plus: true, name: { fr: 'Érosion' }, probability: 2, duration: 3000 },
    ]);
    expect(parseStatuses(dict, 'none')).toEqual([]);
  });

  it('turns the collision into a shape to draw', () => {
    expect(attackShape({ range_type: '1', shape_type: '1', collision_radius: '490', collision_angle: '270' })).toEqual({ kind: 'sector', radius: 490, angle: 270 });
    expect(attackShape({ range_type: '1', shape_type: '2', belt_shape_width: '850', belt_shape_length: '2500' })).toEqual({ kind: 'rect', width: 850, length: 2500 });
    expect(attackShape({ range_type: '1', shape_type: '3', collision_radius: '850', circle_shape_distance: '500' })).toEqual({ kind: 'circle', radius: 850, distance: 500 });
    expect(attackShape({
      range_type: '2', projectile_width: '100', projectile_length: '150', projectile_speed: '2500', projectile_time: '400', projectile_impact_radius: '275',
    })).toEqual({ kind: 'projectile', width: 100, length: 150, range: 1000, impact_radius: 275 });
  });

  it('lists each attack button with its combo steps, a hit and its second part side by side', () => {
    const attacksByGroup = new Map([
      ['n', [
        { atk_number: '2', variation_index: '0', magnification_sum: '100', m_attack_collision_id: 'c', status_effect_type: 'Wek', status_effect_probability: '22', status_effect_time: '8000', cooltime: '0' },
        { atk_number: '1', variation_index: '0', magnification_sum: '90', m_attack_collision_id: 'c', cooltime: '0' },
        { atk_number: '1', variation_index: '1', magnification_sum: '999', m_attack_collision_id: 'c', cooltime: '0' },
      ]],
      ['h', [{ atk_number: '1', variation_index: '0', weapon_attribute: '2', is_advanced_heavy_attack: '1', twice_attack: '1', magnification_sum: '120', projectile_multiple_hit_num: '3', do_down: '1', atk_color: 'blue', cooltime: '8000', heal_type: '1', heal_value: '20' }]],
    ]);
    const collisions = new Map([['c', { range_type: '1', shape_type: '1', collision_radius: '375', collision_angle: '360' }]]);
    const attacks = buildAttacks(dict, { m_character_attack_group_id_normal: 'n', m_character_attack_group_id_heavy1: 'h' }, attacksByGroup, collisions);

    expect(Object.keys(attacks)).toEqual(['normal', 'heavy1']);
    expect(attacks.normal.cooldown).toBeNull();
    expect(attacks.normal.steps.map((s) => [s.step, s.variant, s.power])).toEqual([[1, 0, 90], [1, 1, 999], [2, 0, 100]]);
    expect(attacks.normal.steps[2]).toMatchObject({ statuses: [{ code: 'wek', probability: 22 }], status_probability: 22, status_duration: 8000, shape: { kind: 'sector', radius: 375 } });
    expect(attacks.heavy1).toMatchObject({ cooldown: 8000, steps: [{ power: 120, weapon: 2, advanced: true, twice: true, hits: 3, knockdown: true, color: 'B', heal: 20, shape: null }] });
  });

  it('counts melee hits from the animation windows, projectiles from the table', () => {
    const attacksByGroup = new Map([
      ['n', [{ atk_number: '1', variation_index: '0', m_attack_collision_id: 'c' }, { atk_number: '2', variation_index: '0', m_attack_collision_id: 'c' }]],
      ['h1', [{ atk_number: '1', variation_index: '0', m_attack_collision_id: 'c' }, { atk_number: '1', variation_index: '1', m_attack_collision_id: 'c' }]],
      ['h2', [{ atk_number: '1', variation_index: '0', m_attack_collision_id: 'p' }]],
      ['h3', [{ atk_number: '1', variation_index: '0', m_attack_collision_id: 'c' }, { atk_number: '2', variation_index: '0', m_attack_collision_id: 'c' }]],
      ['ex', [{ atk_number: '1', variation_index: '0', m_attack_collision_id: 'c' }]],
    ]);
    const collisions = new Map([['c', { range_type: '1', shape_type: '1' }], ['p', { range_type: '2' }]]);
    const hits = animationHits([
      { clip: 'Attack1', variation_index: '0', hits: '1' },
      { clip: 'Sp1', variation_index: '0', hits: '2' },
      { clip: 'Sp1', variation_index: '1', hits: '2' },
      { clip: 'Sp3', variation_index: '0', hits: '4' },
    ]);
    const row = {
      m_character_attack_group_id_normal: 'n',
      m_character_attack_group_id_heavy1: 'h1',
      m_character_attack_group_id_heavy2: 'h2',
      m_character_attack_group_id_heavy3: 'h3',
      m_character_attack_group_id_ex: 'ex',
    };
    const attacks = buildAttacks(dict, row, attacksByGroup, collisions, hits);

    expect(attacks.normal.steps.map((s) => s.hits)).toEqual([1, null]);
    expect(attacks.heavy1).toMatchObject({ hits: null, steps: [{ hits: 2 }, { hits: 2 }] });
    expect(attacks.heavy2.steps[0].hits).toBe(1);
    expect(attacks.heavy3).toMatchObject({ hits: 4, steps: [{ hits: null }, { hits: null }] });
    expect(attacks.ex.steps[0].hits).toBeNull();
    expect(buildAttacks(dict, row, attacksByGroup, collisions).heavy1.steps[0].hits).toBeNull();

    // Windows all on the first variation while the table has two: the total is given instead
    const mismatched = buildAttacks(dict, row, attacksByGroup, collisions, animationHits([{ clip: 'Sp1', variation_index: '0', hits: '3' }]));
    expect(mismatched.heavy1).toMatchObject({ hits: 3, steps: [{ hits: 3 }, { hits: null }] });
  });

  it('reads the blasts of a trap and counts them as the hits of its step', () => {
    const traps = new Map([
      ['14', { activate_type: 'Constant', boot_delay: '50', blast_num: '5', blast_cycle: '90' }],
      ['142122', { activate_type: 'Homing', boot_delay: '300', blast_num: '25', blast_cycle: '200', homing_speed: '5000' }],
    ]);
    expect(trapOf({ trap_attack_id: '0' }, traps)).toBeNull();
    expect(trapOf({ trap_attack_id: '142122' }, traps)).toEqual({ hits: 25, interval: 200, duration: 5000, homing: true, delay: 300 });

    const attacksByGroup = new Map([['h', [
      { atk_number: '1', variation_index: '0', m_attack_collision_id: 'c', trap_attack_id: '14' },
      { atk_number: '1', variation_index: '1', m_attack_collision_id: 'c', trap_attack_id: '142122' },
    ]]]);
    const collisions = new Map([['c', { range_type: '1', shape_type: '1', collision_radius: '625' }]]);
    const attacks = buildAttacks(dict, { m_character_attack_group_id_heavy2: 'h' }, attacksByGroup, collisions, undefined, traps);
    expect(attacks.heavy2.steps.map((s) => [s.hits, s.trap.duration, s.trap.homing])).toEqual([[5, 450, false], [25, 5000, true]]);
  });

  it('widens the areas and adds the extra hits of the unit abilities', () => {
    expect(widenShape({ kind: 'projectile', width: 1000, length: 200, range: 1600, impact_radius: 0 }, 20))
      .toEqual({ kind: 'projectile', width: 1200, length: 240, range: 1600, impact_radius: 0 });
    expect(widenShape({ kind: 'circle', radius: 525, distance: 500 }, 20)).toEqual({ kind: 'circle', radius: 630, distance: 600 });

    const step = (radius) => ({ shape: { kind: 'sector', radius, angle: 360 } });
    const attacks = { normal: { steps: [step(375)] }, heavy1: { steps: [step(625)] }, ex: { steps: [step(2000)] } };
    const traits = {
      passive: [{ type: 'sp_atk_range_up_rate', value: 20 }],
      tree: [{ type: 'sp_atk_hit_up_num', value: '4' }, { type: 'ex_atk_hit_up_num', value: '1' }, { type: 'guild_battle_sp_atk_hit_up_num', value: '2' }],
      ex: [],
    };
    const result = applyAttackBonuses(attacks, traits);
    expect(result.heavy1).toMatchObject({ range_bonus: 20, hit_bonus: 4, steps: [{ shape: { radius: 750 } }] });
    expect(result.normal).toMatchObject({ range_bonus: null, hit_bonus: null, steps: [{ shape: { radius: 375 } }] });
    expect(result.ex).toMatchObject({ range_bonus: null, hit_bonus: 1 });
  });

  it('adds the status duration and chance abilities, with the enemies a chance is limited to', () => {
    const attacks = {
      heavy3: { steps: [{ statuses: [{ code: 'ero' }], shape: null }] },
      ex: { steps: [{ statuses: [], shape: null }] },
    };
    const traits = {
      passive: [],
      tree: [
        { type: 'attack_bad_status_up_time', value: 2000 },
        { type: 'attack_bad_status_up_probability', value: 10 },
        { type: 'belong_attribute_bad_status_probability', value: null, ref: '618091' },
      ],
      ex: [],
    };
    const condition = (ref) => (ref === '618091' ? { value: 20, belong: ['Arrancar'], affinity: null } : null);
    const result = applyAttackBonuses(attacks, traits, condition);
    expect(result.heavy3.status_bonus).toEqual({ duration: 2000, probability: 10, conditional: [{ value: 20, belong: ['Arrancar'], affinity: null }] });
    expect(result.ex.status_bonus).toBeNull();
  });
});
