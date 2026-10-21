import sharp from 'sharp';
import { buildCharacterMatcher, mapCharacterRow, nullable } from '../../src/services/characterSource.js';
import { changedImageTargets, composeArtwork } from '../../src/services/characterImages.js';
import { buildSyncPreview } from '../../src/services/characterSync.js';

const legacyRow = {
  'Nom personnage': 'Ichigo Kurosaki',
  'Nom de recherche': 'Ichigo TYBW 2024!',
  'Rareté': '5',
  'Ex Soul Traits': 'NAD +30%, SAD +20%',
  'URL Phrase': 'https://src/quote.png',
  'URL Artwork': 'https://src/art.png',
  'Link': 'https://src/thumb.png',
  'Attaques Rouges ou Bleues': 'Attaques B',
};

const currentRow = {
  ...legacyRow,
  'Ex Soul Traits': undefined,
  'URL Phrase': undefined,
  'Rareté': 'null',
  'Version': '  ',
  'Compétence Ex 1': 'NAD +30%',
  'Compétence Ex 2': 'SAD +20%',
  'Compétences Ex': null,
  'URL Phrase FR': 'https://src/quote.png',
  'URL Phrase EN': 'https://src/quote-en.png',
  'URL Silhouette': 'https://src/silhouette.png',
  'B1': false,
};

describe('mapCharacterRow', () => {
  it('reads the legacy and the current columns the same way', () => {
    const legacy = mapCharacterRow(legacyRow).data;
    const current = mapCharacterRow(currentRow).data;
    expect(current.search_name).toBe('Ichigo TYBW 2024');
    expect(current.ex_soul_traits).toEqual(legacy.ex_soul_traits);
    expect(current.source_images.quote).toBe(legacy.source_images.quote);
    expect(current.source_images.quote_en).toBe('https://src/quote-en.png');
    expect(current.source_images.silhouette).toBe('https://src/silhouette.png');
    expect(current.attack_type).toBe('B');
  });

  it('treats "null" strings and blank cells as empty', () => {
    const { data } = mapCharacterRow(currentRow);
    expect(data.rarity).toBe('');
    expect(data.version).toBe('');
    expect(nullable('null')).toBeNull();
    expect(nullable(false)).toBe(false);
  });

  it('skips rows without a search name', () => {
    expect(mapCharacterRow({ 'Nom de recherche': null })).toBeNull();
    expect(mapCharacterRow({ 'Nom de recherche': '  ' })).toBeNull();
  });
});

describe('buildCharacterMatcher', () => {
  const stored = [
    { _id: 'a', search_name: 'Ichigo TYBW 2024', source_images: { thumbnail: 'https://src/thumb.png' } },
    { _id: 'b', search_name: 'Rukia 2023', source_images: { thumbnail: 'https://src/rukia.png' } },
  ];
  const row = (name, thumb) => mapCharacterRow({ 'Nom de recherche': name, Link: thumb });

  it('matches by search name first', () => {
    const match = buildCharacterMatcher(stored, new Set(['Ichigo TYBW 2024']));
    expect(match(row('Ichigo TYBW 2024', 'https://other.png'))).toEqual({ character: stored[0], renamed: false });
  });

  it('follows a renamed search name through the thumbnail instead of duplicating', () => {
    const match = buildCharacterMatcher(stored, new Set(['Ichigo Bankai 2024']));
    expect(match(row('Ichigo Bankai 2024', 'https://src/thumb.png'))).toEqual({ character: stored[0], renamed: true });
  });

  it('never takes over a character whose name is still in the file', () => {
    const match = buildCharacterMatcher(stored, new Set(['Ichigo TYBW 2024', 'Ichigo copy']));
    expect(match(row('Ichigo copy', 'https://src/thumb.png')).character).toBeNull();
  });

  it('picks the only renamed character among variants sharing a thumbnail', () => {
    const variants = [
      { _id: 'k1', search_name: 'Kon Shop BB', source_images: { thumbnail: 'https://src/kon.png' } },
      { _id: 'k2', search_name: 'Kon Event', source_images: { thumbnail: 'https://src/kon.png' } },
    ];
    const match = buildCharacterMatcher(variants, new Set(['Kon Event', 'Kon Force Shop BB']));
    expect(match(row('Kon Force Shop BB', 'https://src/kon.png'))).toEqual({ character: variants[0], renamed: true });
  });

  it('gives a renamed character to one row only', () => {
    const match = buildCharacterMatcher(stored, new Set(['X', 'Y']));
    expect(match(row('X', 'https://src/rukia.png')).character).toBe(stored[1]);
    expect(match(row('Y', 'https://src/rukia.png')).character).toBeNull();
  });
});

describe('changedImageTargets', () => {
  it('ignores sources that stay empty', () => {
    expect(changedImageTargets({ artwork: 'a' }, { artwork: 'a', silhouette: null, quote_en: null })).toEqual([]);
  });

  it('redoes the artwork when a silhouette is added', () => {
    expect(changedImageTargets({ artwork: 'a' }, { artwork: 'a', silhouette: 's' })).toEqual(['artwork']);
  });
});

describe('buildSyncPreview', () => {
  it('counts inserts, renames, image changes and duplicate rows', () => {
    const stored = [{ _id: 'a', search_name: 'Old', source_images: { thumbnail: 't', artwork: 'a' } }];
    const rows = [
      mapCharacterRow({ 'Nom de recherche': 'New name', Link: 't', 'URL Artwork': 'a', 'URL Silhouette': 's' }),
      mapCharacterRow({ 'Nom de recherche': 'Fresh' }),
      mapCharacterRow({ 'Nom de recherche': 'Fresh' }),
    ];
    const match = buildCharacterMatcher(stored, new Set(rows.map((r) => r.searchName)));
    const preview = buildSyncPreview(4, rows.map((mapped) => ({ mapped, ...match(mapped) })));
    expect(preview.statistics).toMatchObject({ inserted: 2, updated: 1, renamed: 1, skipped: 1, imagesChanged: 1, silhouettes: 1 });
    expect(preview.preview.renamed[0]).toMatchObject({ search_name: 'New name', previous: 'Old' });
    expect(preview.preview.duplicates).toEqual([{ search_name: 'Fresh', count: 2 }]);
  });
});

describe('composeArtwork', () => {
  const solid = (width, height, color) => sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer();

  it('draws the silhouette over the artwork at the artwork size', async () => {
    const artwork = await solid(40, 20, { r: 255, g: 0, b: 0, alpha: 1 });
    // Half transparent, half blue, and twice smaller: scaled up onto the artwork canvas
    const silhouette = await sharp({ create: { width: 20, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await solid(10, 10, { r: 0, g: 0, b: 255, alpha: 1 }), left: 10, top: 0 }])
      .png()
      .toBuffer();

    const merged = await composeArtwork(artwork, silhouette);
    const { data, info } = await sharp(merged).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([40, 20]);
    const pixel = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    expect(pixel(5, 10)).toEqual([255, 0, 0]);
    expect(pixel(35, 10)).toEqual([0, 0, 255]);
  });
});
