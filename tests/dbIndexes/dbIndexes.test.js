import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { ensureIndexes, INDEXES } from '../../src/services/dbIndexes.js';

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

describe('ensureIndexes', () => {
  it('creates every index and can run again', async () => {
    expect(await ensureIndexes(db)).toEqual({ total: INDEXES.length, created: INDEXES.length, failed: [] });
    expect(await ensureIndexes(db)).toMatchObject({ failed: [] });
    const albumIndexes = await db.collection('albums').indexes();
    expect(albumIndexes.find((i) => i.key.bbs_id === 1)).toMatchObject({ unique: true });
  });

  it('reports a unique index blocked by duplicates without stopping the others', async () => {
    await db.dropDatabase();
    await db.collection('albums').insertMany([{ bbs_id: 'dup' }, { bbs_id: 'dup' }]);
    const result = await ensureIndexes(db);
    expect(result.failed).toEqual([expect.objectContaining({ collection: 'albums' })]);
    expect(result.created).toBe(INDEXES.length - 1);
  });
});
