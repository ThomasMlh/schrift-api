import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { bonusAbilityChanges, buildBonusAbilities, saveBonusAbilities } from '../../src/services/gameDb/bonusAbilities.js';

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
  soullink_dodge: { fr: 'Esquive', en: 'Dodge' },
  soullink_heal: { fr: 'Permanence\nBattles seulement', en: 'Prevent Brave Battle Healing' },
};
const dict = { text: (key) => texts[key] ?? null };
const row = (id, type, view, format, description, priority) => ({
  id, type, view_parameter: view, format, description, priority,
});
const tables = {
  m_bonus_ability_slot: [
    row('1', 'dmg_invalid_probability', '15', 'percent', 'soullink_dodge', '9'),
    row('22', 'team_battle_heal_canceller', '', 'none', 'soullink_heal', '30'),
  ],
};

describe('game bonus abilities', () => {
  it('builds one skill per bonus ability with its names and value', () => {
    expect(buildBonusAbilities(tables, dict)).toEqual([
      { game_id: 1, game_type: 'dmg_invalid_probability', name: 'Esquive', names: { fr: 'Esquive', en: 'Dodge' }, value: 15, format: 'percent', priority: 9 },
      {
        game_id: 22,
        game_type: 'team_battle_heal_canceller',
        name: 'Permanence (Battles seulement)',
        names: { fr: 'Permanence (Battles seulement)', en: 'Prevent Brave Battle Healing' },
        value: null,
        format: null,
        priority: 30,
      },
    ]);
  });

  it('replaces the skills entered by hand and keeps the ids of game ones', async () => {
    await db.collection('skills').insertOne({ name: 'Ancienne' });
    const abilities = buildBonusAbilities(tables, dict);
    expect(await bonusAbilityChanges(db, abilities)).toEqual({ skills: 2, newSkills: 2, legacySkills: 1 });

    await saveBonusAbilities(db, abilities);
    const dodge = await db.collection('skills').findOne({ game_id: 1 });
    expect(await db.collection('skills').countDocuments()).toBe(2);

    await saveBonusAbilities(db, abilities);
    expect((await db.collection('skills').findOne({ game_id: 1 }))._id).toEqual(dodge._id);
    expect(await bonusAbilityChanges(db, abilities)).toEqual({ skills: 2, newSkills: 0, legacySkills: 0 });
  });
});
