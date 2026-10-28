import { attackShape, buildAttacks, parseStatuses } from '../../src/services/gameDb/attacks.js';
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
      ['h', [{ atk_number: '1', variation_index: '0', weapon_attribute: '2', magnification_sum: '120', projectile_multiple_hit_num: '3', do_down: '1', atk_color: 'blue', cooltime: '8000', heal_type: '1', heal_value: '20' }]],
    ]);
    const collisions = new Map([['c', { range_type: '1', shape_type: '1', collision_radius: '375', collision_angle: '360' }]]);
    const attacks = buildAttacks(dict, { m_character_attack_group_id_normal: 'n', m_character_attack_group_id_heavy1: 'h' }, attacksByGroup, collisions);

    expect(Object.keys(attacks)).toEqual(['normal', 'heavy1']);
    expect(attacks.normal.cooldown).toBeNull();
    expect(attacks.normal.steps.map((s) => [s.step, s.variant, s.power])).toEqual([[1, 0, 90], [1, 1, 999], [2, 0, 100]]);
    expect(attacks.normal.steps[2]).toMatchObject({ statuses: [{ code: 'wek', probability: 22 }], status_probability: 22, status_duration: 8000, shape: { kind: 'sector', radius: 375 } });
    expect(attacks.heavy1).toMatchObject({ cooldown: 8000, steps: [{ power: 120, weapon: 2, hits: 3, knockdown: true, color: 'B', heal: 20, shape: null }] });
  });
});
