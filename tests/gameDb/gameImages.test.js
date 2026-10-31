import sharp from 'sharp';
import { rmfsImages } from '../../src/services/gameDb/source.js';
import { IMAGE_TARGETS, changedImageTargets, composeOnBackground, uploadImageTarget } from '../../src/services/characterImages.js';

const target = (key) => IMAGE_TARGETS.find((t) => t.key === key);
const rmfs = 'https://bucket.bbs-schrift.fr/rmfs';
const realFetch = global.fetch;

afterAll(() => { global.fetch = realFetch; });

describe('game images', () => {
  // Square canvas, artwork in the bottom half and transparent above, like stand_gacha.png
  const standGacha = () => sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: { create: { width: 40, height: 20, channels: 4, background: { r: 200, g: 50, b: 50, alpha: 1 } } }, top: 20, left: 0 }])
    .png()
    .toBuffer();

  it('reads rmfs through the FTP, trims the artwork, and reports a missing file', async () => {
    global.fetch = async () => { throw new Error('no HTTP expected'); };
    const uploads = {};
    const ftp = {
      downloadBuffer: async (path) => {
        if (path.endsWith('dialog_1615.png')) throw Object.assign(new Error('550'), { status: 404 });
        return path.endsWith('stand_gacha.png') ? standGacha() : Buffer.from('thumb');
      },
      uploadBuffer: async (buffer, path) => { uploads[path] = buffer; },
    };
    const sources = {
      thumbnail: `${rmfs}/Characters/1615/thumb.png`,
      artwork: `${rmfs}/Characters/1615/stand_gacha.png`,
      quote: `${rmfs}/CharacterGacha/TexturesDialog/dialog_1615.png`,
    };

    expect(await uploadImageTarget(ftp, target('thumbnail'), sources, 'c1')).toBe(true);
    expect(await uploadImageTarget(ftp, target('artwork'), sources, 'c1')).toBe(true);
    expect(await uploadImageTarget(ftp, target('quote'), sources, 'c1')).toBe('missing');

    expect(String(uploads['/bucket.bbs-schrift.fr/characters/thumb/c1.png'])).toBe('thumb');

    // One quote picture per language, each with its own translation
    const quoteFtp = { ...ftp, downloadBuffer: async () => sharp({ create: { width: 400, height: 100, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer() };
    const character = { quote: { fr: 'Merci, Zangetsu.', en: 'Thank you, Zangetsu.' } };
    expect(await uploadImageTarget(quoteFtp, target('quote'), sources, 'c2', character)).toBe(true);
    expect(await uploadImageTarget(quoteFtp, target('quote_en'), sources, 'c2', character)).toBe(true);
    const french = uploads['/bucket.bbs-schrift.fr/characters/phrase/fr/c2.png'];
    const english = uploads['/bucket.bbs-schrift.fr/characters/phrase/en/c2.png'];
    expect(french.equals(english)).toBe(false);
    const artwork = await sharp(uploads['/bucket.bbs-schrift.fr/characters/artwork/c1.png']).metadata();
    expect([artwork.width, artwork.height]).toEqual([40, 20]);
  });

  describe('game background', () => {
    const solid = (size, color) => sharp({ create: { width: size, height: size, channels: 4, background: color } }).png().toBuffer();
    const red = { r: 200, g: 0, b: 0, alpha: 1 };
    const blue = { r: 0, g: 0, b: 200, alpha: 1 };
    // Cross-shaped unit in the bottom centre of a transparent square canvas
    const cutOut = (size) => sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([
        { input: { create: { width: size / 4, height: size / 2, channels: 4, background: red } }, top: size / 2, left: Math.round(size * 3 / 8) },
        { input: { create: { width: size / 2, height: Math.round(size / 8), channels: 4, background: red } }, top: Math.round(size * 5 / 8), left: size / 4 },
      ])
      .png()
      .toBuffer();
    const pixel = async (buffer, x, y) => {
      const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      return [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    };

    it.each([1024, 1260])('lays a %i px artwork on its background at the same output size', async (size) => {
      const image = await composeOnBackground(await cutOut(size), await solid(1024, blue));
      const { width, height } = await sharp(image).metadata();
      expect([width, height]).toEqual([1260, 710]);
      expect(await pixel(image, 10, 10)).toEqual([0, 0, 200]);
      expect(await pixel(image, 630, 700)).toEqual([200, 0, 0]);
    });

    it('uses the background of the unit, or the default one of the game', () => {
      const background = (game) => rmfsImages({ resource_2d_id: '1949', ...game }).background;
      expect(background({ background_image_path: 'bg_rainy' })).toMatch(/\/fr\/RarityBg\/bg_rainy\.png$/);
      expect(background({ background_image_path: null })).toMatch(/\/fr\/RarityBg\/default_raritybg_5\.png$/);
    });

    it('queues only the artwork when a unit gets a background', () => {
      const artwork = `${rmfs}/fr/Characters/1/stand_gacha.png`;
      expect(changedImageTargets({ artwork }, { artwork, background: `${rmfs}/fr/RarityBg/bg_rainy.png` })).toEqual(['artwork']);
      expect(changedImageTargets({ artwork }, { artwork })).toEqual([]);
    });

    it('keeps an artwork that has its own scenery', async () => {
      const baked = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: { create: { width: 40, height: 20, channels: 4, background: red } }, top: 20, left: 0 }])
        .png()
        .toBuffer();
      const image = await composeOnBackground(baked, await solid(1024, blue));
      const { width, height } = await sharp(image).metadata();
      expect([width, height]).toEqual([40, 20]);
    });

    it('falls back on the plain artwork and retries when the background cannot be read', async () => {
      const uploads = {};
      const ftp = {
        downloadBuffer: async (path) => {
          if (path.includes('RarityBg')) throw new Error('550');
          return cutOut(1024);
        },
        uploadBuffer: async (buffer, path) => { uploads[path] = buffer; },
      };
      const sources = { artwork: `${rmfs}/fr/Characters/1/stand_gacha.png`, background: `${rmfs}/fr/RarityBg/bg_rainy.png` };
      expect(await uploadImageTarget(ftp, target('artwork'), sources, 'c3')).toBe(false);
      const { width } = await sharp(uploads['/bucket.bbs-schrift.fr/characters/artwork/c3.png']).metadata();
      expect(width).toBe(512);
    });
  });
});
