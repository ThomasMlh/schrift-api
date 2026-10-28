import sharp from 'sharp';
import { IMAGE_TARGETS, uploadImageTarget } from '../../src/services/characterImages.js';

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

    // The quote, white text on a transparent canvas, is laid on an opaque black background
    const quoteFtp = { ...ftp, downloadBuffer: async () => sharp({ create: { width: 4, height: 2, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } }).png().toBuffer() };
    expect(await uploadImageTarget(quoteFtp, target('quote'), sources, 'c2')).toBe(true);
    const { data, info } = await sharp(uploads['/bucket.bbs-schrift.fr/characters/phrase/c2.png']).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect([...data.subarray(0, 3)]).toEqual([0, 0, 0]);
    const artwork = await sharp(uploads['/bucket.bbs-schrift.fr/characters/artwork/c1.png']).metadata();
    expect([artwork.width, artwork.height]).toEqual([40, 20]);
  });
});
