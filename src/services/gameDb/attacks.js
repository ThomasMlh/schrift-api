/**
 * Attacks of a unit (m_character_attack), with the area they hit (m_attack_collision): one entry per
 * attack button (normal combo, strong attacks 1-3, special, EX move), one step per hit of a combo.
 * Distances are game units, durations milliseconds. The tables only count the hits of projectiles:
 * melee hits come from the animations of the model (attack_hits, see tools/attack-hits).
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

// One value per status when several are combined: "0&2" for "Par&Ero"
const valueAt = (raw, index) => {
  const parts = String(raw ?? '').split('&');
  return number(parts[index] ?? parts[0]);
};

// "Wek&Ero_Plus" with probabilities "0&2" -> [{ code: 'wek', plus: false, probability: 0, ... }, { code: 'ero', plus: true, probability: 2, ... }]
export const parseStatuses = (dict, raw, probabilities = '', durations = '') => {
  if (!raw || raw === 'none') return [];
  return raw.split('&').map((part, index) => {
    const plus = /_plus$/i.test(part);
    const code = part.replace(/_plus$/i, '').toLowerCase();
    return {
      code,
      plus,
      name: dict.text(STATUS_NAMES[code]) ?? { fr: code },
      probability: valueAt(probabilities, index),
      duration: valueAt(durations, index),
    };
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

// Area left on the ground (vortex, mine...) that hits several times: m_trap_attack
export const trapOf = (row, traps) => {
  if (!filled(row.trap_attack_id)) return null;
  const trap = traps.get(row.trap_attack_id);
  if (!trap) return { hits: null, interval: null, duration: null, homing: false, delay: null };
  const hits = number(trap.blast_num) || null;
  const interval = number(trap.blast_cycle) || null;
  return {
    hits,
    interval,
    duration: hits && interval ? hits * interval : number(trap.life_time) || null,
    // Follows the nearest enemy instead of staying where it was set
    homing: trap.activate_type === 'Homing',
    delay: number(trap.boot_delay),
  };
};

// Hits of a step: a trap's blasts, projectiles from the table, melee from the hit windows of its animation, null when unknown
const stepHits = (row, shape, windows, trap) => {
  if (trap?.hits) return trap.hits;
  const projectiles = number(row.projectile_multiple_hit_num);
  if (projectiles > 0) return projectiles;
  if (shape?.kind === 'projectile') return 1;
  return windows || null;
};

const attackStep = (dict, row, collisions, traps, windows) => {
  const shape = attackShape(collisions.get(row.m_attack_collision_id));
  const trap = trapOf(row, traps);
  return {
    step: number(row.atk_number),
    // Second part of the same hit (e.g. the blast after a strong attack lands)
    variant: number(row.variation_index) ?? 0,
    power: number(row.magnification_sum),
    // Weapon of the attack (fist, sword, bow, kidô...), picks the button icon in the game interface
    weapon: number(row.weapon_attribute),
    hits: stepHits(row, shape, windows, trap),
    knockdown: row.do_down === '1',
    // Advanced strong attack (spiked button in the game) and double strike
    advanced: row.is_advanced_heavy_attack === '1',
    twice: row.twice_attack === '1',
    color: COLORS[row.atk_color] ?? null,
    shape,
    statuses: parseStatuses(dict, row.status_effect_type, row.status_effect_probability, row.status_effect_time),
    status_probability: Math.max(0, ...String(row.status_effect_probability ?? '').split('&').map(Number).filter(Number.isFinite)),
    status_duration: Math.max(0, ...String(row.status_effect_time ?? '').split('&').map(Number).filter(Number.isFinite)),
    heal: filled(row.heal_type) ? number(row.heal_value) : null,
    // target 1 = the character, 2 = the whole party
    buff: filled(row.buff_target_type)
      ? {
        target: number(row.buff_target_type),
        atk: number(row.buff_atk_value),
        def: number(row.buff_def_value),
        crt: number(row.buff_crt_value),
        sp: number(row.buff_sp_value),
        duration: number(row.buff_effect_time),
      }
      : null,
    barrier: filled(row.barrier_effect_id),
    revival: filled(row.revival_id),
    trap,
  };
};

export const ATTACK_BUTTONS = ['normal', 'heavy1', 'heavy2', 'heavy3', 'ex', 'extra_action'];

// Animation of each button; the normal combo plays Attack1, Attack2... one per step
const CLIPS = { heavy1: 'Sp1', heavy2: 'Sp2', heavy3: 'Sp3', ex: 'Skill', extra_action: 'Extra' };

// attack_hits rows of one model -> windows(clip, variation) and total(clip)
export const animationHits = (rows = []) => {
  const counts = new Map(rows.map((r) => [`${r.clip}|${Number(r.variation_index) || 0}`, Number(r.hits) || 0]));
  const totals = new Map();
  for (const r of rows) totals.set(r.clip, (totals.get(r.clip) ?? 0) + (Number(r.hits) || 0));
  return {
    windows: (clip, variation) => counts.get(`${clip}|${variation}`) ?? 0,
    total: (clip) => totals.get(clip) ?? 0,
  };
};

const NO_HITS = animationHits();

// Attack buttons of a unit, hits in order (a hit and its second part, variation_index, side by side)
export const buildAttacks = (dict, row, attacksByGroup, collisions, hits = NO_HITS, traps = new Map()) => Object.fromEntries(ATTACK_BUTTONS
  .map((button) => {
    const rows = [...(attacksByGroup.get(row[`m_character_attack_group_id_${button}`]) ?? [])]
      .sort((a, b) => Number(a.atk_number) - Number(b.atk_number) || Number(a.variation_index || 0) - Number(b.variation_index || 0));
    if (rows.length === 0) return [button, null];
    // A strong attack with several steps (e.g. a follow-up) plays one animation for all of them: its
    // windows cannot be shared out, only their total is known
    const shared = button !== 'normal' && new Set(rows.map((attack) => attack.atk_number)).size > 1;
    const clipOf = (attack) => (button === 'normal' ? `Attack${number(attack.atk_number)}` : CLIPS[button]);
    const steps = rows.map((attack) => attackStep(dict, attack, collisions, traps, shared ? 0 : hits.windows(clipOf(attack), number(attack.variation_index) ?? 0)));
    // Windows that do not match the variations of the table: only their total is reliable
    const unmatched = !shared && button !== 'normal' && steps.some((step) => step.hits === null);
    return [button, {
      cooldown: Math.max(...rows.map((attack) => number(attack.cooltime) ?? 0)) || null,
      hits: shared || unmatched ? hits.total(CLIPS[button]) || null : null,
      steps,
    }];
  })
  .filter(([, attack]) => attack));

// Abilities of the unit that change its attacks, by button: wider areas (percent) and extra hits
const RANGE_BONUSES = { normal: 'normal_atk_range_up_rate', heavy: 'sp_atk_range_up_rate', ex: 'ex_atk_range_up_rate' };
const HIT_BONUSES = { normal: 'normal_atk_hit_up_num', heavy: 'sp_atk_hit_up_num', ex: 'ex_atk_hit_up_num' };
const bonusKey = (button) => (button.startsWith('heavy') ? 'heavy' : button);

const scaled = (value, rate) => (value === null ? null : Math.round(value * rate));
// A circle placed ahead of the character moves away with it: its distance grows too
const SCALED_FIELDS = { sector: ['radius'], rect: ['width', 'length'], circle: ['radius', 'distance'], projectile: ['width', 'length', 'impact_radius'] };

export const widenShape = (shape, percent) => {
  if (!shape || !percent) return shape;
  const rate = 1 + percent / 100;
  return { ...shape, ...Object.fromEntries(SCALED_FIELDS[shape.kind].map((field) => [field, scaled(shape[field], rate)])) };
};

// Status chance against some enemies only (m_ability_regist_belong_attribute), pointed to by the ability
const CONDITIONAL_STATUS_CHANCES = new Set(['belong_attribute_bad_status_probability', 'attribute_bad_status_probability']);

// Applies the unit's own abilities (passives, fully unlocked soul tree, EX): areas are shown at their
// widest, as in battle. Extra hits are only given beside the hits, the game adds them on its side.
// condition(ref): { value, belong, affinity } of a conditional status chance, null when unknown.
export const applyAttackBonuses = (attacks, traits, condition = () => null) => {
  const all = [...traits.passive, ...traits.tree, ...traits.ex];
  const totals = new Map();
  for (const trait of all) {
    const value = Number(trait.value);
    if (trait.type && Number.isFinite(value)) totals.set(trait.type, (totals.get(trait.type) ?? 0) + value);
  }
  // Same for every attack that inflicts a status: longer statuses (ms), a higher chance (percent)
  const statusBonus = {
    duration: totals.get('attack_bad_status_up_time') || 0,
    probability: totals.get('attack_bad_status_up_probability') || 0,
    conditional: all.filter((trait) => CONDITIONAL_STATUS_CHANCES.has(trait.type) && trait.ref).map((trait) => condition(trait.ref)).filter(Boolean),
  };
  const hasStatusBonus = statusBonus.duration > 0 || statusBonus.probability > 0 || statusBonus.conditional.length > 0;
  return Object.fromEntries(Object.entries(attacks).map(([button, attack]) => {
    const key = bonusKey(button);
    const range = totals.get(RANGE_BONUSES[key]) || null;
    const hitBonus = totals.get(HIT_BONUSES[key]) || null;
    return [button, {
      ...attack,
      range_bonus: range,
      hit_bonus: hitBonus,
      status_bonus: hasStatusBonus && attack.steps.some((step) => step.statuses?.length > 0) ? statusBonus : null,
      steps: range ? attack.steps.map((step) => ({ ...step, shape: widenShape(step.shape, range) })) : attack.steps,
    }];
  }));
};
