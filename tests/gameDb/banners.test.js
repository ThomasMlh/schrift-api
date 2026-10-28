import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { buildGameBanners, removeLegacyBanners, saveGameBanners, uploadGameBanners } from '../../src/services/gameDb/banners.js';

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

    // rmfs is read through the FTP, not over HTTP
    const uploads = [];
    const reads = [];
    const ftp = {
      uploadBuffer: async (buffer, path) => uploads.push(path),
      downloadBuffer: async (path) => {
        reads.push(path);
        if (path.includes('_867_')) throw Object.assign(new Error('550'), { status: 404 });
        return Buffer.from('png');
      },
    };
    global.fetch = async () => { throw new Error('no HTTP expected'); };
    expect(await uploadGameBanners(db, ftp, 10)).toEqual({ uploaded: 1, processed: 2 });
    expect(uploads).toEqual(['/bucket.bbs-schrift.fr/banners/gacha_866.png']);
    expect(reads).toEqual(['/bucket.bbs-schrift.fr/rmfs/Localize/bn_gacha_limited_866_sub.png', '/bucket.bbs-schrift.fr/rmfs/Localize/bn_gacha_limited_867_sub.png']);
    expect((await banner(867)).image_status).toBe('missing');

    // Next sync: 866 is kept as uploaded, 867 is tried again
    await saveGameBanners(db, buildGameBanners(characters));
    expect((await banner(866)).image_status).toBe('uploaded');
    expect((await banner(867)).image_status).toBe('pending');
    expect(await db.collection('banners').countDocuments()).toBe(4);
  });

  it('removes the banners entered on the site once, and never a game summon', async () => {
    await db.collection('characters').insertOne({ name: 'Ichigo', banner_id: 'old' });
    expect(await removeLegacyBanners(db)).toBe(1);
    expect(await db.collection('characters').countDocuments({ banner_id: { $exists: true } })).toBe(0);

    // A later sync whose tables no longer list 868 adds 869 and keeps every known summon
    await saveGameBanners(db, buildGameBanners([{ game_id: 1, banners: [summon(869)] }]));
    expect(await removeLegacyBanners(db)).toBe(0);
    expect((await db.collection('banners').find().toArray()).map((b) => b.gacha_group_id).sort()).toEqual([866, 867, 868, 869]);
  });
});
