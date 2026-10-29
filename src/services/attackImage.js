/**
 * Picture of the attack buttons of a character, rebuilt like the game battle screen from the button
 * pieces of the game interface (Atlas_QuestBattle, copied to the bucket under game-ui/attacks).
 * Every piece keeps its atlas size times the scale of its button, icons go back into their atlas frame,
 * status badges keep their own size: the result matches a screenshot of the game.
 */
import sharp from 'sharp';

export const ATTACK_PIECES_PATH = '/bucket.bbs-schrift.fr/game-ui/attacks';
const WIDTH = 294;
const HEIGHT = 280;
// A unit with an EX move gets its button on the left: the screen is wider and the others move right
const EX_MOVE_SHIFT = 84;
// Room around the canvas for pieces that stick out (badges), cut off at the end
const MARGIN = 40;

// Button centers and circle diameters on the game screen: the big one is the normal attack
const SLOTS = {
  normal: { x: 209.5, y: 195, size: 164 },
  heavy1: { x: 60, y: 230, size: 97 },
  heavy2: { x: 60.5, y: 129, size: 97 },
  heavy3: { x: 134, y: 59, size: 97 },
  ex: { x: 239, y: 60, size: 97 },
};
const EX_MOVE_SLOT = { x: 41.5, y: 154.5, size: 76 };

// Diameter of the circle drawn by a background at its atlas size: 168 px pieces (normal buttons) have a 1 px
// edge, the 99 px ones (strong attacks, special) a ring of 97
const circleOf = (base) => {
  if (/^bt_(fighting|projectile|heal)$/.test(base)) return 166;
  return base.startsWith('ex_action_base') ? 76 : 97;
};

// Atlas frame of the icons: trimmed images go back to their place in it before being centered on the button
const NORMAL_ICON_FRAMES = {
  '1_normal': { frame: [112, 124], offset: [11, 0] },
  '2_normal': { frame: [112, 124], offset: [11, 0] },
  '3_normal': { frame: [112, 124], offset: [10, 0] },
  '4_normal': { frame: [112, 124], offset: [11, 0] },
  '5_normal': { frame: [112, 124], offset: [11, 0] },
};
const iconFrame = (icon) => {
  if (NORMAL_ICON_FRAMES[icon]) return NORMAL_ICON_FRAMES[icon];
  if (icon === 'ex_action01') return { frame: [70, 70], offset: [6, 6] };
  return /_(special1|skill1)$/.test(icon) ? { frame: [88, 88], offset: [8, 8] } : { frame: [88, 88], offset: [7, 8] };
};

// Weapon icons the game has: "<weapon>_<button>"
const WEAPON_ICONS = new Set([
  '10_heavy3', '10_special1', '11_heavy3', '11_skill1',
  '1_heavy1', '1_heavy2', '1_heavy3', '1_normal', '2_heavy1', '2_heavy2', '2_heavy3', '2_normal',
  '3_heavy1', '3_heavy2', '3_heavy3', '3_normal', '4_heavy1', '4_heavy2', '4_heavy3', '4_normal',
  '5_heavy1', '5_heavy2', '5_heavy3', '5_normal', '6_heavy1', '6_heavy2', '6_heavy3', '6_heavy4',
  '7_heavy1', '7_heavy2', '7_heavy3', '8_heavy3', '9_heavy3',
]);
const STATUS_CODES = new Set(['brn', 'cnf', 'ero', 'frz', 'inj', 'par', 'psn', 'spd', 'tko', 'wek']);

// Same rules as the attack buttons of the character page (front utils/attackIcons.ts)
export const buttonBase = (button, steps) => {
  if (button === 'extra_action') return steps.some((s) => s.color === 'B') ? 'ex_action_base01' : 'ex_action_base02';
  if (button === 'ex') return 'bt_skill';
  const heavy = button.startsWith('heavy') ? (steps.some((s) => s.advanced) ? '_heavy_plus' : '_heavy') : '';
  if (steps.some((s) => s.buff)) return `bt_buff${heavy || '_heavy'}`;
  if (steps.some((s) => s.heal)) return `bt_heal${heavy}`;
  return `${steps.some((s) => s.color === 'B') ? 'bt_projectile' : 'bt_fighting'}${heavy}`;
};

export const buttonIcon = (button, steps) => {
  if (button === 'extra_action') return 'ex_action01';
  if (button === 'ex') return steps.some((s) => s.revival) ? '10_special1' : '11_skill1';
  if (steps.some((s) => s.twice)) return '11_heavy3';
  const buff = steps.find((s) => s.buff)?.buff;
  const weapon = buff ? (buff.target === 2 ? 7 : 6) : steps.some((s) => s.heal) ? 5 : steps.find((s) => s.weapon)?.weapon;
  if (!weapon) return null;
  const candidates = [`${weapon}_${button}`, `${weapon}_heavy3`, `${weapon}_normal`, `${weapon}_heavy1`];
  return candidates.find((name) => WEAPON_ICONS.has(name)) ?? [...WEAPON_ICONS].find((name) => name.startsWith(`${weapon}_`)) ?? null;
};

export const statusBadges = (steps) => {
  const seen = new Map();
  for (const status of steps.flatMap((s) => s.statuses ?? [])) {
    if (!STATUS_CODES.has(status.code)) continue;
    const key = `${status.code}${status.plus ? '+' : ''}`;
    if (!seen.has(key)) seen.set(key, { icon: `ailment_${status.code}`, plus: status.plus });
  }
  return [...seen.values()].slice(0, 2);
};

// Heal of a buff that also heals: a drop badge on the bottom right
const subBadge = (steps) => (steps.some((s) => s.buff) && steps.some((s) => s.heal) ? 'sub_5' : null);

const hasButton = (attacks, button) => (attacks?.[button]?.steps?.length ?? 0) > 0;

// Size of the picture: wider for a unit with an EX move
export const attackImageSize = (attacks) => ({ width: WIDTH + (hasButton(attacks, 'extra_action') ? EX_MOVE_SHIFT : 0), height: HEIGHT });

// Status badge: a dark disc with a gold ring, the status icon in the middle, an orange "+" on the top left
const BADGE = { base: 'ailment_base_heavy_02', scale: 0.95, size: 50, icon: 34, offset: [-7, -6], next: 13 };

// Buttons of the unit, placed for its layout
const slotsOf = (attacks) => {
  if (!hasButton(attacks, 'extra_action')) return Object.entries(SLOTS);
  return [
    ...Object.entries(SLOTS).map(([button, slot]) => [button, { ...slot, x: slot.x + EX_MOVE_SHIFT }]),
    ['extra_action', EX_MOVE_SLOT],
  ];
};

// Pieces to draw, in order, with their place on the canvas (before the margin)
export const attackImageLayout = (attacks) => slotsOf(attacks).flatMap(([button, slot]) => {
  const steps = attacks?.[button]?.steps;
  if (!steps?.length) return [];
  const base = buttonBase(button, steps);
  const scale = slot.size / circleOf(base);
  const pieces = [{ name: base, x: slot.x, y: slot.y, scale, anchor: 'center' }];

  const icon = buttonIcon(button, steps);
  if (icon) {
    const { frame, offset } = iconFrame(icon);
    // Top left of the icon inside its frame, the frame centered on the button
    pieces.push({ name: icon, x: slot.x + (offset[0] - frame[0] / 2) * scale, y: slot.y + (offset[1] - frame[1] / 2) * scale, scale, anchor: 'top-left' });
  }

  const left = slot.x - slot.size / 2;
  const top = slot.y - slot.size / 2;
  statusBadges(steps).forEach((badge, index) => {
    const x = left + BADGE.offset[0] + index * BADGE.next;
    const y = top + BADGE.offset[1];
    const middle = BADGE.size / 2;
    pieces.push({ name: BADGE.base, x, y, scale: BADGE.scale, anchor: 'top-left' });
    pieces.push({ name: badge.icon, x: x + middle, y: y + middle, scale: BADGE.icon / 36, anchor: 'center' });
    if (badge.plus) pieces.push({ name: 'ailment_plus', x: x - 3, y: y - 3, scale: 1, anchor: 'top-left' });
  });

  const sub = subBadge(steps);
  if (sub) {
    const x = slot.x + slot.size / 2 - 30;
    const y = slot.y + slot.size / 2 - 30;
    pieces.push({ name: 'ailment_base_2', x, y, scale: 1, anchor: 'top-left' });
    pieces.push({ name: sub, x: x - 3, y: y - 3, scale: 43 / 54, anchor: 'top-left' });
  }
  return pieces;
});

// loadPiece(name) -> PNG buffer of a button piece; a missing piece is left out
export const renderAttackImage = async (attacks, loadPiece) => {
  const layers = [];
  for (const piece of attackImageLayout(attacks)) {
    const buffer = await loadPiece(piece.name).catch(() => null);
    if (!buffer) continue;
    const { width, height } = await sharp(buffer).metadata();
    const w = Math.max(1, Math.round(width * piece.scale));
    const h = Math.max(1, Math.round(height * piece.scale));
    const input = w === width && h === height ? buffer : await sharp(buffer).resize(w, h).png().toBuffer();
    const left = piece.anchor === 'center' ? piece.x - w / 2 : piece.x;
    const top = piece.anchor === 'center' ? piece.y - h / 2 : piece.y;
    layers.push({ input, left: Math.round(left) + MARGIN, top: Math.round(top) + MARGIN });
  }
  if (layers.length === 0) return null;
  const { width, height } = attackImageSize(attacks);
  const canvas = await sharp({
    create: { width: width + MARGIN * 2, height: height + MARGIN * 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite(layers).png().toBuffer();
  return sharp(canvas).extract({ left: MARGIN, top: MARGIN, width, height }).png().toBuffer();
};
