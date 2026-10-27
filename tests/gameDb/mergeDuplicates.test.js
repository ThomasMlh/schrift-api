import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import { mergeDuplicates } from '../../src/services/gameDb/mergeDuplicates.js';
import { syncCharactersFromSFTP } from '../../src/services/characterSync.js';

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

describe('mergeDuplicates', () => {
  it('moves album entries and build members to the kept character, then deletes the duplicate', async () => {
    const keep = new ObjectId();
    const twin = new ObjectId();
    const other = new ObjectId().toString();
    await db.collection('characters').insertMany([{ _id: keep, game_id: 65115 }, { _id: twin }]);
    await db.collection('albums').insertMany([
      { bbs_id: 'a', characters: { [twin]: 4, [keep]: 2 } },
      { bbs_id: 'b', characters: { [twin]: 1 } },
      { bbs_id: 'c', characters: { [other]: 3 } },
    ]);
    await db.collection('builds').insertOne({
      team: [
        { id_character: String(twin), links: [{ id_character: other }, { id_character: String(twin) }] },
        { id_character: other, links: [] },
      ],
    });

    const result = await mergeDuplicates(db, [{ game_id: 65115, keep_id: keep, merge_ids: [twin] }]);

    expect(result).toEqual([{ keep_id: String(keep), merged_id: String(twin), albums: 2, builds: 2 }]);
    const albums = Object.fromEntries((await db.collection('albums').find().toArray()).map((a) => [a.bbs_id, a.characters]));
    expect(albums).toEqual({ a: { [keep]: 4 }, b: { [keep]: 1 }, c: { [other]: 3 } });
    const build = await db.collection('builds').findOne();
    expect(build.team.map((m) => [m.id_character, m.links.map((l) => l.id_character)])).toEqual([
      [String(keep), [other, String(keep)]],
      [other, []],
    ]);
    expect(await db.collection('characters').countDocuments({ _id: twin })).toBe(0);
  });
});

describe('legacy database.json sync', () => {
  it('refuses to run once characters come from the game tables', async () => {
    await expect(syncCharactersFromSFTP(db, { dryRun: true })).rejects.toMatchObject({ statusCode: 409 });
  });
});
