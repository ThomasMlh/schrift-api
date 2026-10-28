import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import {
  accessoryChanges, buildAccessories, buildSubeffects, saveAccessories, uploadAccessoryImages,
} from '../../src/services/gameDb/accessories.js';

jest.setTimeout(60000);

let mongod;
let client;
let db;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

const texts = {
  acc_name_1: 'Bague', acc_detail_1: 'Une bague',
  acc_name_2: 'Collier', acc_detail_2: 'Un collier',
  accessory_effect_atk_up_detail: 'Attaque +{value1} %',
  accessory_effect_hp_up_detail: 'Endurance +{value1} %',
};
const dict = {
  text: (key, values = {}) => (texts[key]
    ? { fr: Object.entries(values).reduce((text, [k, v]) => text.replace(`{${k}}`, v), texts[key]) }
    : null),
};

const accessory = (id, identity, rarity, plus, effect, attribute = '6') => ({
  id, identity_id: identity, rarity, is_rarity_plus: plus ? '1' : '0', attribute, m_accessory_effect_id: effect,
  name: `acc_name_${identity}`, detail: `acc_detail_${identity}`, resource_2d_id: `acc_${identity}`,
});
const effect = (id, value) => ({
  id, detail_dictkey_part: 'atk_up', effect_type_1: 'atk', parameter_max_1: String(value), target_belong_types: '', target_killer_types: '',
});
const tables = {
  m_accessory: [
    accessory('10', '1', '4', false, 'e1'),
    accessory('11', '1', '5', false, 'e2'),
    accessory('12', '1', '5', true, 'e3'),
    accessory('20', '2', '5', false, 'e2'),
    accessory('21', '1', '5', true, 'e3', '1'),
  ],
  m_constant: [{ id: 'accessory.same_attribute_bonus_rate', value: '2' }],
  m_accessory_effect: [effect('e1', 10), effect('e2', 20), effect('e3', 30)],
  m_accessory_second_effect_lot_stop_type: [
    { target_effect_type: 'hp_up', border_max_parameter: '20' },
    { target_effect_type: 'hp_up', border_max_parameter: '40' },
  ],
};

describe('game accessories', () => {
  it('keeps the 5★+ version when there is one, the 5★ one otherwise, at the max level', () => {
    const [ring, necklace] = buildAccessories(tables, dict);
    expect(ring).toMatchObject({ game_identity_id: 1, name: 'Bague', rarity: '5★+', code: 'acc_1' });
    expect(necklace).toMatchObject({ game_identity_id: 2, rarity: '5★', effect: { values: [20] }, effects_by_affinity: null, same_affinity_rate: null });
    expect(ring.image_source).toMatch(/\/fr\/Accessories\/acc_1\/thumb\.png$/);
  });

  it('doubles the effect of an accessory of the character affinity', () => {
    const [ring] = buildAccessories(tables, dict);
    expect(ring.same_affinity_rate).toBe(2);
    // The no-affinity version keeps its value, the affinity one is doubled
    expect(ring.effects_by_affinity.map((v) => [v.affinities, v.effect.values])).toEqual([[[null], [30]], [['Technique'], [60]]]);
  });

  it('keeps the highest value of each second effect, without affinity bonus', () => {
    expect(buildSubeffects(tables, dict)).toEqual([{ game_type: 'hp_up', value: 40, name: 'Endurance +40 %', names: { fr: 'Endurance +40 %' } }]);
  });

  it('replaces the accessories entered by hand and keeps the ids of game ones', async () => {
    await db.collection('accessories').insertOne({ name: 'Ancien' });
    await db.collection('accessories_subeffect').insertOne({ name: 'Ancien' });
    const accessories = buildAccessories(tables, dict);
    const subeffects = buildSubeffects(tables, dict);
    expect(await accessoryChanges(db, accessories)).toEqual({ accessories: 2, newAccessories: 2, legacyAccessories: 2, accessoryImages: 2 });

    await saveAccessories(db, accessories, subeffects, new Date(), (url) => !url.includes('acc_2'));
    const ring = await db.collection('accessories').findOne({ game_identity_id: 1 });
    expect(await db.collection('accessories').countDocuments()).toBe(2);
    expect(await db.collection('accessories_subeffect').countDocuments()).toBe(1);
    expect(ring.image_status).toBe('pending');
    expect((await db.collection('accessories').findOne({ game_identity_id: 2 })).image_status).toBe('missing');

    await saveAccessories(db, accessories, subeffects);
    expect((await db.collection('accessories').findOne({ game_identity_id: 1 }))._id).toEqual(ring._id);
    expect(await accessoryChanges(db, accessories)).toMatchObject({ newAccessories: 0, legacyAccessories: 0 });
  });

  it('copies pending pictures to the bucket folder of the builds', async () => {
    const ftp = { uploadBuffer: jest.fn() };
    const download = jest.fn(async (_, url) => {
      if (url.includes('acc_2')) throw new Error('404');
      return Buffer.from('png');
    });
    expect(await uploadAccessoryImages(db, ftp, 10, download)).toEqual({ uploaded: 1, processed: 2 });
    expect(ftp.uploadBuffer).toHaveBeenCalledWith(Buffer.from('png'), '/bucket.bbs-schrift.fr/accessories/acc_1/thumb.png');
    expect((await db.collection('accessories').findOne({ game_identity_id: 2 })).image_status).toBe('missing');
    // An uploaded picture is not queued again
    await saveAccessories(db, buildAccessories(tables, dict), []);
    expect((await db.collection('accessories').findOne({ game_identity_id: 1 })).image_status).toBe('uploaded');
  });
});
