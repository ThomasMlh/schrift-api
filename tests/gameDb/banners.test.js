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
    const banners = buildGameBanners(characters, ['en']);
    expect(banners.map((b) => [b.gacha_group_id, b.character_game_ids])).toEqual([[866, [65116, 65122]], [867, [65122]], [868, [65122]]]);
    // One visual per client language, each in its rmfs language folder
    expect(banners[0]).toMatchObject({
      name: 'Loterie 866',
      image_source: 'https://bucket.bbs-schrift.fr/rmfs/fr/Localize/bn_gacha_limited_866_sub.png',
      translation_sources: { en: 'https://bucket.bbs-schrift.fr/rmfs/en/Localize/bn_gacha_limited_866_sub.png' },
    });
  });

  it('copies each visual once per language, and looks again at the next sync for those rmfs did not have', async () => {
    await db.collection('banners').insertOne({ name: 'Bannière du site', url: 'https://x/banner.png' });
    await saveGameBanners(db, buildGameBanners(characters, ['en']));
    expect(await db.collection('banners').countDocuments()).toBe(4);
    expect((await banner(866)).images_pending).toEqual(['fr', 'en']);
    expect((await banner(868)).images_pending).toEqual([]);

    // rmfs is read through the FTP, not over HTTP
    const uploads = [];
    const reads = [];
    const ftp = {
      uploadBuffer: async (buffer, path) => uploads.push(path),
      downloadBuffer: async (path) => {
        reads.push(path);
        if (path.includes('_867_') || path.includes('/en/')) throw Object.assign(new Error('550'), { status: 404 });
        return Buffer.from('png');
      },
    };
    global.fetch = async () => { throw new Error('no HTTP expected'); };
    expect(await uploadGameBanners(db, ftp, 10)).toEqual({ uploaded: 1, processed: 2 });
    expect(uploads).toEqual(['/bucket.bbs-schrift.fr/banners/gacha_866.png']);
    expect(reads).toContain('/bucket.bbs-schrift.fr/rmfs/fr/Localize/bn_gacha_limited_866_sub.png');
    expect(reads).toContain('/bucket.bbs-schrift.fr/rmfs/en/Localize/bn_gacha_limited_866_sub.png');
    expect(await banner(867)).toMatchObject({ image_status: 'missing', images_pending: [] });
    expect((await banner(866)).translations.en.image_status).toBe('missing');

    // The English visual arrives with a newer rmfs: copied next to the French one
    await saveGameBanners(db, buildGameBanners(characters, ['en']));
    expect((await banner(866)).images_pending).toEqual(['en']);
    expect((await banner(867)).images_pending).toEqual(['fr', 'en']);
    ftp.downloadBuffer = async () => Buffer.from('png');
    uploads.length = 0;
    await uploadGameBanners(db, ftp, 10);
    expect(uploads).toEqual(expect.arrayContaining(['/bucket.bbs-schrift.fr/banners/gacha_866.en.png', '/bucket.bbs-schrift.fr/banners/gacha_867.png']));
    expect(uploads).not.toContain('/bucket.bbs-schrift.fr/banners/gacha_866.png');
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
