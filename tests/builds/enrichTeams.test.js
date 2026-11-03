import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import { enrichTeams } from '../../src/routes/builds/enrich.js';

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

describe('enrichTeams', () => {
  it('attaches characters, links, skills and accessories to every team', async () => {
    const [ichigo, rukia] = Object.values((await db.collection('characters').insertMany([
      {
        name: 'Ichigo',
        rarity: 'UR',
        traits: {
          link: [{ type: 'a', name: { fr: 'A' }, text: { fr: 'Effet A' } }],
          ex: [{ kind: 'ex', type: 'ex_atk', ref: '1', values: [10, 12, 14, 16, 18], text: { fr: 'ATQ +10 > 18 %' } }],
        },
      },
      {
        name: 'Rukia',
        rarity: 'SR',
        traits: { link: [{ type: 'b', value: 8, text: { fr: 'Base' } }] },
        resurrection: { traits: { link: [{ type: 'b', value: 12, name: { fr: 'B' }, text: { fr: 'Ressuscitée' } }] } },
      },
    ])).insertedIds).map(String);
    const skill = String((await db.collection('skills').insertOne({ name: 'Getsuga' })).insertedId);
    const accessory = String((await db.collection('accessories').insertOne({ name: 'Ring', code: 'R1' })).insertedId);
    const subeffect = String((await db.collection('accessories_subeffect').insertOne({ name: 'ATK' })).insertedId);

    const teams = [
      [{
        id_character: ichigo,
        position: 1,
        links: [{ id_character: rukia }, { id_character: String(new ObjectId()) }],
        skills: [skill, 'not-an-id'],
        accessories: [{ id_accessory: accessory, id_subeffect: subeffect }, { id_accessory: 'bad' }],
      }],
      [{ position: 1 }, { id_character: rukia, position: 2 }],
    ];

    const [first, second] = await enrichTeams(teams, db);

    expect(first[0].character).toEqual({
      _id: new ObjectId(ichigo),
      name: 'Ichigo',
      rarity: 'UR',
      ex_traits: [{ text: { fr: 'ATQ +10 > 18 %' }, values: [10, 12, 14, 16, 18] }],
    });
    expect(first[0].links.map((l) => l.character?.name ?? null)).toEqual(['Rukia', null]);
    expect(first[0].links[0].character.link_traits).toEqual([{ name: { fr: 'B' }, text: { fr: 'Ressuscitée' } }]);
    expect(first[0].links[0].character.ex_traits).toEqual([]);
    expect(first[0].skills.map((s) => s.name)).toEqual(['Getsuga']);
    expect(first[0].accessories).toEqual([{
      accessory: { _id: new ObjectId(accessory), name: 'Ring', code: 'R1' },
      subeffect: { _id: new ObjectId(subeffect), name: 'ATK' },
    }]);
    expect(second[0]).toEqual({ position: 1 });
    expect(second[1]).toMatchObject({ character: { name: 'Rukia' }, links: [], skills: [], accessories: [] });
  });

  it('falls back on the base soul traits of a link without a resurrected form', async () => {
    const [ichigo, rukia] = Object.values((await db.collection('characters').insertMany([
      { name: 'Ichigo' },
      { name: 'Rukia', traits: { link: [{ type: 'b', name: { fr: 'B' }, text: { fr: 'Base' } }] } },
    ])).insertedIds).map(String);

    const [[member]] = await enrichTeams([[{ id_character: ichigo, position: 1, links: [{ id_character: rukia }] }]], db);

    expect(member.links[0].character.link_traits).toEqual([{ name: { fr: 'B' }, text: { fr: 'Base' } }]);
  });
});
