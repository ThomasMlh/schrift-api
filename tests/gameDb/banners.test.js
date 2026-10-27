import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { buildGameBanners, saveGameBanners, uploadGameBanners } from '../../src/services/gameDb/banners.js';

jest.setTimeout(60000);

let mongod;
let client;
let db;
const realFetch = global.fetch;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('schrift-test');
});

afterAll(async () => {
  global.fetch = realFetch;
  await client.close();
  await mongod.stop();
});

const summon = (id, image = true) => ({
  gacha_group_id: id, name: { fr: `Loterie ${id}` }, start_date: '25/09/2026', end_date: '11/10/2026',
  image_path: image ? `Localize/bn_gacha_limited_${id}_sub` : null,
});
const characters = [
  { game_id: 65116, banners: [summon(866)] },
  { game_id: 65122, banners: [summon(866), summon(867), summon(868, false)] },
];
const banner = (id) => db.collection('banners').findOne({ gacha_group_id: id });

describe('game summons', () => {
  it('builds one banner per summon with the characters featured in it', () => {
    const banners = buildGameBanners(characters);
    expect(banners.map((b) => [b.gacha_group_id, b.character_game_ids])).toEqual([[866, [65116, 65122]], [867, [65122]], [868, [65122]]]);
    expect(banners[0]).toMatchObject({ name: 'Loterie 866', image_source: 'https://bucket.bbs-schrift.fr/rmfs/Localize/bn_gacha_limited_866_sub.png' });
  });

  it('copies each visual once, and looks again at the next sync for those rmfs did not have', async () => {
    await db.collection('banners').insertOne({ name: 'Bannière du site', url: 'https://x/banner.png' });
    await saveGameBanners(db, buildGameBanners(characters));
    expect(await db.collection('banners').countDocuments()).toBe(4);
    expect((await banner(866)).image_status).toBe('pending');
    expect((await banner(868)).image_status).toBe('missing');

    const uploads = [];
    const ftp = { uploadBuffer: async (buffer, path) => uploads.push(path) };
    global.fetch = async (url) => (url.includes('_867_') ? { ok: false, status: 404 } : { ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
    expect(await uploadGameBanners(db, ftp, 10)).toEqual({ uploaded: 1, processed: 2 });
    expect(uploads).toEqual(['/bucket.bbs-schrift.fr/banners/gacha_866.png']);
    expect((await banner(867)).image_status).toBe('missing');

    // Next sync: 866 is kept as uploaded, 867 is tried again
    await saveGameBanners(db, buildGameBanners(characters));
    expect((await banner(866)).image_status).toBe('uploaded');
    expect((await banner(867)).image_status).toBe('pending');
    expect(await db.collection('banners').countDocuments()).toBe(4);
  });
});
