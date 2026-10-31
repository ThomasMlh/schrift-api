import { botFields, matchBotRows, patchBotDatabase } from '../../src/services/botDatabase.js';
import { toSearchName } from '../../src/services/characterSource.js';

// Written like the bot file: Python json.dumps with an indent of 4, floats kept as "4.0"
const FILE = `[
    {
        "Nom personnage": null,
        "Nom de recherche": null
    },
    {
        "Nom personnage": "Ichigo Kurosaki",
        "Nom de recherche": "Ichigo TYBW 2024!",
        "Link": "https://i.ibb.co/old.png",
        "Flurry EN QG": 4.0,
        "Lien, autre": "a,"
    },
    {
        "Nom personnage": "Rukia Kuchiki",
        "Nom de recherche": "Rukia Bankai",
        "SAR": 0.12
    }
]`;

describe('bot database file', () => {
  it('changes only the given fields, adds the missing ones at the end, keeps the rest as it is', () => {
    const patched = patchBotDatabase(FILE, new Map([[1, { Link: 'https://bucket/thumb.png', 'Base ID': 'abc', 'Game ID': 61758 }]]));
    expect(patched).toBe(`[
    {
        "Nom personnage": null,
        "Nom de recherche": null
    },
    {
        "Nom personnage": "Ichigo Kurosaki",
        "Nom de recherche": "Ichigo TYBW 2024!",
        "Link": "https://bucket/thumb.png",
        "Flurry EN QG": 4.0,
        "Lien, autre": "a,",
        "Base ID": "abc",
        "Game ID": 61758
    },
    {
        "Nom personnage": "Rukia Kuchiki",
        "Nom de recherche": "Rukia Bankai",
        "SAR": 0.12
    }
]`);
  });

  it('finds the character of each row by id, search name, then name, affinity and release date', () => {
    const character = (id, fields) => ({ _id: id, killers: [], attack_type: 'R', affinity: 'Force', release_date: '01/01/2026', ...fields });
    const characters = [
      character('a', { name: 'Ichigo Kurosaki', search_name: toSearchName('Ichigo TYBW 2024!'), game_id: 1 }),
      character('b', { name: 'Shigekuni Genryûsai Yamamoto', search_name: 'Yamomoto TYBW Force 2022', game_id: 2 }),
      character('c', { name: 'Rukia Kuchiki', search_name: 'Rukia game name', killers: ['Quincy +'], attack_type: 'B', game_id: 3 }),
      character('d', { name: 'Rukia Kuchiki', search_name: 'Rukia other', killers: ['Hollow'], game_id: 4 }),
      character('e', { name: 'Renji Abarai', search_name: 'Renji', game_id: 5 }),
    ];
    const rows = [
      { 'Nom de recherche': null },
      { 'Nom de recherche': 'Ichigo TYBW 2024!' },
      { 'Nom de recherche': 'Yamamoto TYBW Force 2022', 'Nom personnage': 'Shigekuni Genryusai Yamamoto', 'Affinité': 'Force', 'Date sortie': '01/01/2026' },
      { 'Nom de recherche': 'Rukia new', 'Nom personnage': 'Rukia Kuchiki', 'Affinité': 'Force', 'Date sortie': '01/01/2026', Killers: 'Quincy +', 'Attaques Rouges ou Bleues': 'Attaques B' },
      { 'Nom de recherche': 'Unknown', 'Nom personnage': 'Nobody', 'Affinité': 'Force', 'Date sortie': '01/01/2026' },
      { 'Nom de recherche': 'Ichigo copy', 'Base ID': 'a' },
      { 'Nom de recherche': 'Renji renamed', 'Game ID': 5 },
    ];
    const { matches, unresolved, missing } = matchBotRows(rows, characters);
    expect(matches.map((m) => [m.index, String(m.character._id), m.method])).toEqual([
      [1, 'a', 'search_name'],
      [2, 'b', 'identity'],
      [3, 'c', 'identity'],
      [6, 'e', 'id'],
    ]);
    expect(unresolved).toEqual([
      { index: 4, label: 'Unknown', reason: 'none' },
      { index: 5, label: 'Ichigo copy', reason: 'duplicate', other: 'Ichigo TYBW 2024!' },
    ]);
    expect(missing.map((c) => c._id)).toEqual(['d']);
  });

  it('gives the quote texts and the picture of each language', () => {
    const files = { thumb: new Set(), artwork: new Set(), 'phrase/fr': new Set(['a.png', 'b.png']), 'phrase/en': new Set(['a.png']), attack: new Set(), banners: new Set() };
    const options = { files, uploadedBanners: new Set() };
    expect(botFields({ _id: 'a', quote: { fr: 'Merci, Zangetsu.', en: 'Thank you, Zangetsu.' } }, options)).toMatchObject({
      'URL Phrase FR': 'https://bucket.bbs-schrift.fr/characters/phrase/fr/a.png',
      'URL Phrase EN': 'https://bucket.bbs-schrift.fr/characters/phrase/en/a.png',
      'Phrase FR': 'Merci, Zangetsu.',
      'Phrase EN': 'Thank you, Zangetsu.',
    });
    const frenchOnly = botFields({ _id: 'b', quote: { fr: 'Texte' } }, options);
    expect(frenchOnly).not.toHaveProperty('URL Phrase EN');
    expect(frenchOnly).not.toHaveProperty('Phrase EN');
    // Group 0 holds the old summons in the game tables: not a summon id
    expect(botFields({ _id: 'c', banners: [{ gacha_group_id: 0 }] }, options)).not.toHaveProperty('Game Banner ID');
  });

  it('gives only the images present on the bucket, and the release summon when it was archived', () => {
    const files = { thumb: new Set(['a.png']), artwork: new Set(['a.png']), 'phrase/fr': new Set(), 'phrase/en': new Set(), attack: new Set(['a.png']), banners: new Set(['gacha_562.png']) };
    const fields = botFields({ _id: 'a', game_id: 61727, banners: [{ gacha_group_id: 562 }] }, { files, uploadedBanners: new Set([562]) });
    expect(fields).toEqual({
      'Base ID': 'a',
      'Game ID': 61727,
      'Game Banner ID': 562,
      Link: 'https://bucket.bbs-schrift.fr/characters/thumb/a.png',
      'URL Artwork': 'https://bucket.bbs-schrift.fr/characters/artwork/a.png',
      'URL ATK': 'https://bucket.bbs-schrift.fr/characters/attack/a.png',
      'URL Portail': 'https://bucket.bbs-schrift.fr/banners/gacha_562.png',
    });
  });
});
