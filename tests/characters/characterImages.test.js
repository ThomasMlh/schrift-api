import sharp from 'sharp';
import { changedImageTargets, composeArtwork } from '../../src/services/characterImages.js';

describe('changedImageTargets', () => {
  it('ignores sources that stay empty', () => {
    expect(changedImageTargets({ artwork: 'a' }, { artwork: 'a', silhouette: null, quote_en: null })).toEqual([]);
  });

  it('redoes the artwork when a silhouette is added', () => {
    expect(changedImageTargets({ artwork: 'a' }, { artwork: 'a', silhouette: 's' })).toEqual(['artwork']);
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
