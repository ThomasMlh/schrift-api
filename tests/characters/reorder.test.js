import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { reorderCharactersByReleaseDate } from '../../src/utils/characterHelpers.js';

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

describe('reorderCharactersByReleaseDate', () => {
  it('follows the game book, then the release date for units it does not list', async () => {
    await db.collection('characters').insertMany([
      { name: 'Aizen', release_date: '24/10/2026', book_order: 4090 },
      { name: 'Ichigo', release_date: '24/10/2026', book_order: 4095 },
      { name: 'Byakuya', release_date: '24/10/2026' },
      { name: 'Rukia', release_date: '25/10/2026', book_order: 3211 },
      { name: 'Renji', release_date: '26/10/2026' },
    ]);
    await reorderCharactersByReleaseDate(db);
    const names = (await db.collection('characters').find().sort({ sort_order: 1 }).toArray()).map((c) => c.name);
    expect(names).toEqual(['Ichigo', 'Aizen', 'Rukia', 'Renji', 'Byakuya']);
  });
});
