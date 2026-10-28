/**
 * Attacks of a unit (m_character_attack), with the area they hit (m_attack_collision): one entry per
 * attack button (normal combo, strong attacks 1-3, special, EX move), one step per hit of a combo.
 * Distances are game units, durations milliseconds.
 */
const COLORS = { red: 'R', blue: 'B' };

// Status codes of the attack table -> dictionary key of their name
const STATUS_NAMES = {
  brn: 'lb_status_effect_type_brn',
  frz: 'lb_status_effect_type_frz',
  psn: 'lb_status_effect_type_psn',
  par: 'lb_status_effect_type_par',
  cnf: 'lb_status_effect_type_cnf',
  spd: 'lb_status_effect_type_spd',
  wek: 'lb_status_effect_type_wek',
  inj: 'lb_status_effect_type_inj',
  ero: 'ui_common_resitance_erosion',
  tko: 'ui_quest_system_bad_status_table_title_10',
};

const number = (value) => (value === '' || value === undefined || Number.isNaN(Number(value)) ? null : Number(value));
const filled = (value) => Boolean(value) && value !== '0';

// "Wek&Ero_Plus" -> [{ code: 'wek', plus: false, name }, { code: 'ero', plus: true, name }]
export const parseStatuses = (dict, raw) => {
  if (!raw || raw === 'none') return [];
  return raw.split('&').map((part) => {
    const plus = /_plus$/i.test(part);
    const code = part.replace(/_plus$/i, '').toLowerCase();
    return { code, plus, name: dict.text(STATUS_NAMES[code]) ?? { fr: code } };
  });
};

// Area hit by an attack, drawn on the character page
export const attackShape = (collision) => {
  if (!collision) return null;
  if (collision.range_type === '2') {
    return {
      kind: 'projectile',
      width: number(collision.projectile_width),
      length: number(collision.projectile_length),
      // Distance travelled before the projectile vanishes
      range: number(collision.projectile_speed) && number(collision.projectile_time)
        ? Math.round((Number(collision.projectile_speed) * Number(collision.projectile_time)) / 1000)
        : null,
      impact_radius: number(collision.projectile_impact_radius),
    };
  }
  if (collision.shape_type === '2') return { kind: 'rect', width: number(collision.belt_shape_width), length: number(collision.belt_shape_length) };
  if (collision.shape_type === '3') return { kind: 'circle', radius: number(collision.collision_radius), distance: number(collision.circle_shape_distance) };
  return { kind: 'sector', radius: number(collision.collision_radius), angle: number(collision.collision_angle) || 360 };
};

const attackStep = (dict, row, collisions) => ({
  step: number(row.atk_number),
  power: number(row.magnification_sum),
  hits: Math.max(1, number(row.projectile_multiple_hit_num) ?? 0),
  knockdown: row.do_down === '1',
  color: COLORS[row.atk_color] ?? null,
  shape: attackShape(collisions.get(row.m_attack_collision_id)),
  statuses: parseStatuses(dict, row.status_effect_type),
  status_probability: number(row.status_effect_probability),
  status_duration: number(row.status_effect_time),
  heal: filled(row.heal_type) ? number(row.heal_value) : null,
  buff: filled(row.buff_target_type)
    ? { atk: number(row.buff_atk_value), def: number(row.buff_def_value), crt: number(row.buff_crt_value), sp: number(row.buff_sp_value), duration: number(row.buff_effect_time) }
    : null,
  barrier: filled(row.barrier_effect_id),
  revival: filled(row.revival_id),
  trap: filled(row.trap_attack_id),
});

export const ATTACK_BUTTONS = ['normal', 'heavy1', 'heavy2', 'heavy3', 'ex', 'extra_action'];

// Attack buttons of a unit; alternate versions of a hit (variation_index > 0) are left out
export const buildAttacks = (dict, row, attacksByGroup, collisions) => Object.fromEntries(ATTACK_BUTTONS
  .map((button) => {
    const rows = (attacksByGroup.get(row[`m_character_attack_group_id_${button}`]) ?? [])
      .filter((attack) => !filled(attack.variation_index))
      .sort((a, b) => Number(a.atk_number) - Number(b.atk_number));
    if (rows.length === 0) return [button, null];
    return [button, {
      cooldown: Math.max(...rows.map((attack) => number(attack.cooltime) ?? 0)) || null,
      steps: rows.map((attack) => attackStep(dict, attack, collisions)),
    }];
  })
  .filter(([, attack]) => attack));
