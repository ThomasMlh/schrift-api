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
      { name: 'Ichigo', rarity: 'UR', soul_traits: ['a'] },
      { name: 'Rukia', rarity: 'SR', soul_traits: ['b'] },
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

    expect(first[0].character).toEqual({ _id: new ObjectId(ichigo), name: 'Ichigo', rarity: 'UR' });
    expect(first[0].links.map((l) => l.character?.name ?? null)).toEqual(['Rukia', null]);
    expect(first[0].links[0].character.soul_traits).toEqual(['b']);
    expect(first[0].skills.map((s) => s.name)).toEqual(['Getsuga']);
    expect(first[0].accessories).toEqual([{
      accessory: { _id: new ObjectId(accessory), name: 'Ring', code: 'R1' },
      subeffect: { _id: new ObjectId(subeffect), name: 'ATK' },
    }]);
    expect(second[0]).toEqual({ position: 1 });
    expect(second[1]).toMatchObject({ character: { name: 'Rukia' }, links: [], skills: [], accessories: [] });
  });
});
