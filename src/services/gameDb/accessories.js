/**
 * Accessories and their second effects, from the game tables, as builds use them. Only the strongest
 * version of each accessory is kept: 5★+ when the game has one, 5★ otherwise, its effect at the max level.
 * An accessory of the character's affinity has its main effect multiplied (x2): builds assume it matches,
 * so values include that bonus, except for accessories without affinity. Second effects have no bonus. Accessories are keyed by the game identity (game_identity_id), second effects by their type.
 */
import { AFFINITIES, BELONG_TYPES } from './buildCharacters.js';
import { PRIMARY_LANGUAGE, rmfsUrl } from './source.js';

const TOP_RARITY = '5';
const NO_AFFINITY = '6';

// Multiplier of the effects when the accessory has the affinity of the character
const sameAffinityRate = (tables) => Number(tables.m_constant?.find((row) => row.id === 'accessory.same_attribute_bonus_rate')?.value) || 1;
const times = (value, rate) => Math.round(value * rate * 100) / 100;

const number = (value) => (value === '' || value === undefined || Number.isNaN(Number(value)) ? null : Number(value));

// Effect at its max level: up to 4 values filling {value1}...{value4} of the effect text
const effectOf = (dict, effect, rate) => {
  if (!effect) return null;
  const baseValues = [1, 2, 3, 4].map((i) => number(effect[`parameter_max_${i}`])).filter((v, i) => effect[`effect_type_${i + 1}`] && v);
  const values = baseValues.map((v) => times(v, rate));
  const placeholders = Object.fromEntries(values.map((v, i) => [`value${i + 1}`, v]));
  return {
    type: effect.detail_dictkey_part,
    values,
    base_values: baseValues,
    targets: (effect.target_belong_types || '').split('&').map((t) => BELONG_TYPES[t]).filter(Boolean),
    killers: (effect.target_killer_types || '').split('&').map((t) => BELONG_TYPES[t]).filter(Boolean),
    text: dict.text(`accessory_effect_${effect.detail_dictkey_part}_detail`, placeholders),
  };
};

export const buildAccessories = (tables, dict) => {
  const rate = sameAffinityRate(tables);
  const effects = new Map(tables.m_accessory_effect.map((e) => [e.id, e]));
  const byIdentity = new Map();
  for (const row of tables.m_accessory.filter((a) => a.rarity === TOP_RARITY)) {
    if (!byIdentity.has(row.identity_id)) byIdentity.set(row.identity_id, []);
    byIdentity.get(row.identity_id).push(row);
  }

  return [...byIdentity.entries()].map(([identityId, rows]) => {
    const plus = rows.some((r) => r.is_rarity_plus === '1');
    const kept = rows.filter((r) => (r.is_rarity_plus === '1') === plus);
    // The affinity versions of an accessory usually share their effect; one per distinct effect otherwise
    const variants = new Map();
    for (const row of kept) {
      const effect = effectOf(dict, effects.get(row.m_accessory_effect_id), row.attribute === NO_AFFINITY ? 1 : rate);
      const key = JSON.stringify(effect);
      if (!variants.has(key)) variants.set(key, { effect, affinities: [] });
      variants.get(key).affinities.push(row.attribute === NO_AFFINITY ? null : AFFINITIES[row.attribute] ?? null);
    }
    const first = kept[0];
    const names = dict.text(first.name);
    const withAffinity = kept.some((r) => r.attribute !== NO_AFFINITY);
    return {
      game_identity_id: Number(identityId),
      name: names?.[PRIMARY_LANGUAGE] ?? Object.values(names ?? {})[0] ?? `#${identityId}`,
      names,
      description: dict.text(first.detail),
      code: first.resource_2d_id,
      rarity: plus ? '5★+' : '5★',
      affinities: [...new Set(kept.map((r) => (r.attribute === NO_AFFINITY ? null : AFFINITIES[r.attribute] ?? null)))],
      // Bonus already counted in the effect values, null for an accessory without affinity
      same_affinity_rate: withAffinity && rate !== 1 ? rate : null,
      effect: [...variants.values()][0].effect,
      // Only when the affinity versions have different effects
      effects_by_affinity: variants.size > 1 ? [...variants.values()] : null,
      image_source: rmfsUrl(`Accessories/${first.resource_2d_id}/thumb.png`),
    };
  });
};

// Second effects, each at its highest value
export const buildSubeffects = (tables, dict) => {
  const best = new Map();
  for (const row of tables.m_accessory_second_effect_lot_stop_type) {
    const value = number(row.border_max_parameter);
    if (value && value > (best.get(row.target_effect_type) ?? 0)) best.set(row.target_effect_type, value);
  }
  return [...best.entries()].map(([type, value]) => {
    const text = dict.text(`accessory_effect_${type}_detail`, { value1: value });
    return { game_type: type, value, name: text?.[PRIMARY_LANGUAGE] ?? type, names: text };
  });
};

const ACCESSORY_IMAGES = '/bucket.bbs-schrift.fr/accessories';
export const accessoryImagePath = (code) => `${ACCESSORY_IMAGES}/${code}/thumb.png`;

// Accessories and second effects entered on the site before the game data: replaced, removed once
const legacyFilter = { game_identity_id: { $exists: false } };
const legacySubeffectFilter = { game_type: { $exists: false } };

export const accessoryChanges = async (db, accessories) => {
  const known = new Set(await db.collection('accessories').distinct('game_identity_id', { game_identity_id: { $exists: true } }));
  return {
    accessories: accessories.length,
    newAccessories: accessories.filter((a) => !known.has(a.game_identity_id)).length,
    legacyAccessories: await db.collection('accessories').countDocuments(legacyFilter)
      + await db.collection('accessories_subeffect').countDocuments(legacySubeffectFilter),
    accessoryImages: accessories.length - await db.collection('accessories').countDocuments({ image_status: 'uploaded' }),
  };
};

// Upserts by game key, so the ids builds point to never change; an image is queued when rmfs has it
export const saveAccessories = async (db, accessories, subeffects, now = new Date(), exists = () => true) => {
  await db.collection('accessories').deleteMany(legacyFilter);
  await db.collection('accessories_subeffect').deleteMany(legacySubeffectFilter);
  if (accessories.length > 0) {
    await db.collection('accessories').bulkWrite(accessories.map((accessory) => ({
      updateOne: {
        filter: { game_identity_id: accessory.game_identity_id },
        update: { $set: { ...accessory, game_synced_at: now }, $setOnInsert: { created_at: now } },
        upsert: true,
      },
    })), { ordered: false });
    await db.collection('accessories').updateMany(
      { game_identity_id: { $exists: true }, image_status: { $ne: 'uploaded' } },
      { $set: { image_status: 'missing' } }
    );
    const queued = accessories.filter((a) => exists(a.image_source)).map((a) => a.game_identity_id);
    await db.collection('accessories').updateMany(
      { game_identity_id: { $in: queued }, image_status: { $ne: 'uploaded' } },
      { $set: { image_status: 'pending' } }
    );
  }
  if (subeffects.length > 0) {
    await db.collection('accessories_subeffect').bulkWrite(subeffects.map((subeffect) => ({
      updateOne: {
        filter: { game_type: subeffect.game_type },
        update: { $set: { ...subeffect, game_synced_at: now }, $setOnInsert: { created_at: now } },
        upsert: true,
      },
    })), { ordered: false });
  }
};

// Copies pending accessory pictures from rmfs to the bucket folder the builds read
export const uploadAccessoryImages = async (db, ftp, limit, download) => {
  const pending = await db.collection('accessories').find({ image_status: 'pending' }).limit(limit).toArray();
  let uploaded = 0;
  for (const accessory of pending) {
    const buffer = await download(ftp, accessory.image_source).catch(() => null);
    if (buffer) {
      await ftp.uploadBuffer(buffer, accessoryImagePath(accessory.code));
      uploaded += 1;
    }
    await db.collection('accessories').updateOne({ _id: accessory._id }, { $set: { image_status: buffer ? 'uploaded' : 'missing' } });
  }
  return { uploaded, processed: pending.length };
};

export const pendingAccessoryImages = (db) => db.collection('accessories').countDocuments({ image_status: 'pending' });
