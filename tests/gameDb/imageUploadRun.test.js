import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { trackUploadRun } from '../../src/services/imageUploadRun.js';

jest.mock('../../src/utils/notifyDiscord.js', () => ({ notifyDiscord: jest.fn() }));
import { notifyDiscord } from '../../src/utils/notifyDiscord.js';

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

describe('image upload run', () => {
  it('tells Discord about the start, each quarter and the end, not every batch', async () => {
    const messages = [];
    notifyDiscord.mockImplementation(async (type, data) => messages.push(data.message));
    // 200 items, 40 per batch
    let remaining = 200;
    while (remaining > 0) {
      const before = remaining;
      remaining = Math.max(0, remaining - 40);
      await trackUploadRun(db, { remainingBefore: before, remainingAfter: remaining, uploaded: 40, errors: 0 });
    }
    expect(messages).toEqual([
      'Envoi des images lancé : 200 élément(s) à traiter',
      'Envoi des images : 25 %',
      'Envoi des images : 50 %',
      'Envoi des images : 75 %',
      'Envoi des images terminé : 200 image(s) envoyée(s)',
    ]);
    expect(await db.collection('app_settings').findOne({ _id: 'image_upload_run' })).toBeNull();
  });
});
