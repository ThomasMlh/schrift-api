import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import {
  archiveSummonRates, newsCharacterIds, parseSummonRates, pendingSummonRates, queueSummonRates, ratePagePaths, ratesArchivePath,
} from '../../src/services/gameDb/summonRates.js';

jest.setTimeout(60000);

const unit = (name, version, element = 1) => `<tr><td>${name}</td><td>5★</td><td class="element"><img src="https://x/common-icon-attribute-${element}.png"></td><td>${version}</td><td class="possession-status"><span>Non possédé</span></td></tr>`;
const section = (title, rows) => `<section><h3 class="common-page-title">${title}</h3><table class="gacha-rate-character-table"><tr><th>Personnage</th></tr>${rows}</table></section>`;
const rates = '<section><h3>Chances</h3><h4>Loterie Marine</h4><table class="gacha-rate-rarity-table"><tr><th>5★</th></tr><tr><td><span>3%</span><br>Total : 6 personnages<br>(Par personnage : 1 %)</td></tr></table></section>';
const page = (...sections) => `<html>${rates}${sections.join('')}</html>`;
const selection = section('Personnages 5★ de la sélection (total : 2)', unit('Ichigo', 'version 3<sup>e</sup> fusion') + unit('Inconnu', ''));
const available = section('Personnages disponibles (total : 2)', unit('Ichigo', 'version 3<sup>e</sup> fusion') + unit('Renji', '', 3));

const ftpWith = (files = {}) => ({
  files,
  downloadBuffer: async (path) => {
    if (!(path in files)) throw Object.assign(new Error('missing'), { status: 404 });
    return Buffer.from(files[path]);
  },
  uploadBuffer: async (buffer, path) => { files[path] = buffer.toString('utf8'); },
});

describe('summon rates', () => {
  describe('page', () => {
    it('reads the sections, their units and the rate tables', () => {
      const parsed = parseSummonRates(page(section('Nouveaux personnages 5★ (total : 1)', unit('Bazz-B', 'version 2024', 3)), selection, available));
      expect(parsed.sections.map((s) => [s.kind, s.units.length])).toEqual([['new', 1], ['selection', 2], ['available', 2]]);
      expect(parsed.sections[0].units[0]).toEqual({ name: 'Bazz-B', rarity: 5, affinity: 'Force', version: 'version 2024' });
      expect(parsed.sections[1].units[1].version).toBeNull();
      expect(parsed.tables).toEqual([{
        title: 'Loterie Marine',
        rows: [
          { header: true, cells: [['5★']] },
          { header: false, cells: [['3%', 'Total : 6 personnages', '(Par personnage : 1 %)']] },
        ],
      }]);
    });

    it('asks for the units of a character summon, the rates only for an accessory one', () => {
      const details = { main_gacha_id: 8662 };
      expect(ratePagePaths({ gacha_group_id: 866, list_category: 'character_gacha', details })).toEqual([
        'gacha_rate/character_gacha_rate?gacha_group_id=866', 'gacha_rate/index?gacha_id=8662',
      ]);
      expect(ratePagePaths({ gacha_group_id: 55, list_category: 'accessory_ticket', details })).toEqual(['gacha_rate/index?gacha_id=8662']);
    });

    it('reads the character ids of a news', () => {
      expect(newsCharacterIds('<img src="x/Characters/61687/thumb.png"><img src="x/Characters/1687/a.png">')).toEqual(new Set([61687, 1687]));
    });
  });

  describe('batch', () => {
    let mongod;
    let client;
    let db;
    const realFetch = global.fetch;
    const started = new Date('2026-09-01T00:00:00Z');
    const banner = (id, fields) => ({ gacha_group_id: id, list_category: 'character_gacha', started_at: started, details: { news_id: 900, main_gacha_id: id * 10 }, ...fields });
    const doc = (id) => db.collection('banners').findOne({ gacha_group_id: id });

    beforeAll(async () => {
      mongod = await MongoMemoryServer.create();
      client = new MongoClient(mongod.getUri());
      await client.connect();
      db = client.db('schrift-test');
    });

    beforeEach(async () => {
      await db.dropDatabase();
      global.fetch = jest.fn(async () => ({ ok: true, text: async () => '<html>accueil</html>' }));
      await db.collection('characters').insertMany([
        { game_id: 61001, short_names: { fr: 'Ichigo' }, game_version: { fr: 'version 3e fusion' }, affinity: 'Technique', release_date: '01/01/2020' },
        { game_id: 61002, short_names: { fr: 'Isshin' }, game_version: null, affinity: 'Technique', release_date: '01/01/2020' },
        { game_id: 61003, short_names: { fr: 'Isshin' }, game_version: null, affinity: 'Technique', release_date: '01/01/2021' },
        { game_id: 61004, short_names: { fr: 'Kon' }, game_version: null, affinity: 'Technique', release_date: '01/01/2020' },
        { game_id: 61005, short_names: { fr: 'Kon' }, game_version: null, affinity: 'Technique', release_date: '01/01/2030' },
      ]);
    });

    afterAll(async () => {
      global.fetch = realFetch;
      await client.close();
      await mongod.stop();
    });

    it('links the units of an archived page and keeps the unknown ones unlinked', async () => {
      await db.collection('banners').insertOne(banner(1, { rates_pending: true }));
      const ftp = ftpWith({ [ratesArchivePath(1)]: page(selection, available) });
      expect(await archiveSummonRates(db, ftp, 10)).toEqual({ archived: 1, processed: 1 });
      const { rates: stored, rates_status: status, rates_pending: pending } = await doc(1);
      expect(status).toBe('archived');
      expect(pending).toBeUndefined();
      expect(stored.available_count).toBe(2);
      expect(stored.sections).toHaveLength(1);
      expect(stored.sections[0].units.map((u) => u.game_id)).toEqual([61001, null]);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('keeps the available list of a ticket without selection only', async () => {
      await db.collection('banners').insertOne(banner(2, { list_category: 'character_ticket', rates_pending: true }));
      await archiveSummonRates(db, ftpWith({ [ratesArchivePath(2)]: page(available) }), 10);
      expect((await doc(2)).rates.sections.map((s) => s.kind)).toEqual(['available']);
    });

    it('settles sheets sharing an identity with the news, then the release date, otherwise leaves no link', async () => {
      const rows = unit('Isshin', '') + unit('Kon', '');
      await db.collection('banners').insertMany([banner(3, { rates_pending: true }), banner(4, { rates_pending: true, details: { main_gacha_id: 40 } })]);
      const ftp = ftpWith({
        [ratesArchivePath(3)]: page(section('Personnages 5★ de la sélection (total : 2)', rows)),
        [ratesArchivePath(4)]: page(section('Personnages 5★ de la sélection (total : 2)', rows)),
        '/game-news/fr/900.html': '<img src="x/Characters/61003/thumb.png">',
      });
      await archiveSummonRates(db, ftp, 10);
      expect((await doc(3)).rates.sections[0].units.map((u) => u.game_id)).toEqual([61003, 61004]);
      // No news: both Isshin sheets are released, only one Kon sheet is
      expect((await doc(4)).rates.sections[0].units.map((u) => u.game_id)).toEqual([null, 61004]);
    });

    it('fetches, archives and marks missing pages', async () => {
      await db.collection('banners').insertMany([banner(5, { rates_pending: true }), banner(6, { rates_pending: true })]);
      global.fetch = jest.fn(async (url) => ({ ok: true, text: async () => (url.includes('gacha_group_id%3D5') ? page(selection) : '<html>accueil</html>') }));
      const ftp = ftpWith();
      await archiveSummonRates(db, ftp, 10);
      expect((await doc(5)).rates_status).toBe('archived');
      expect(ftp.files[ratesArchivePath(5)]).toContain('gacha-rate-rarity-table');
      expect((await doc(6)).rates_status).toBe('missing');
      expect(ftp.files[ratesArchivePath(6)]).toBeUndefined();
      expect(await pendingSummonRates(db)).toBe(0);
    });

    it('queues new and upcoming summons and recent missing ones, not old missing ones', async () => {
      const now = new Date('2026-09-20T00:00:00Z');
      await db.collection('banners').insertMany([
        banner(7),
        banner(8, { rates_status: 'missing' }),
        banner(9, { rates_status: 'missing', started_at: new Date('2026-01-01T00:00:00Z') }),
        banner(10, { rates_status: 'archived' }),
        banner(11, { started_at: new Date('2026-10-01T00:00:00Z') }),
        banner(13, { rates_status: 'missing', started_at: new Date('2026-10-01T00:00:00Z') }),
        { gacha_group_id: 12, started_at: started },
      ]);
      expect(await queueSummonRates(db, now)).toBe(4);
      expect((await db.collection('banners').find({ rates_pending: true }).toArray()).map((b) => b.gacha_group_id)).toEqual([7, 8, 11, 13]);
    });
  });
});
