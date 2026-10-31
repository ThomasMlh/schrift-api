import sharp from 'sharp';
import { renderQuoteImage } from '../src/services/quoteImage.js';

const quote = (width, height) => sharp({ create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();

const brightRows = async (image) => {
  const { data, info } = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
  const rows = [];
  for (let y = 0; y < info.height; y += 1) {
    if (data.subarray(y * info.width, (y + 1) * info.width).some((value) => value > 128)) rows.push(y);
  }
  return { rows, info };
};

describe('quote image', () => {
  it('centres the quote on a black canvas the size of the artworks and writes the text at the bottom', async () => {
    const { rows, info } = await brightRows(await renderQuoteImage(await quote(400, 100), 'Merci, Zangetsu.'));
    expect([info.width, info.height]).toEqual([1260, 710]);
    expect(rows[0]).toBe(305);
    expect(rows).toContain(404);
    expect(rows).not.toContain(450);
    expect(rows.at(-1)).toBeGreaterThan(600);
  });

  it('draws the whole translation', async () => {
    const image = await renderQuoteImage(await quote(400, 100), 'À la fête du Nouvel An, je vais danser pour le bonheur de tous !');
    const { data, info } = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
    const columns = new Set();
    for (let y = 600; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) if (data[y * info.width + x] > 128) columns.add(x);
    }
    expect(Math.max(...columns) - Math.min(...columns)).toBeGreaterThan(800);
    expect(Math.abs(Math.max(...columns) + Math.min(...columns) - info.width)).toBeLessThan(20);
  });

  it('keeps only the centred quote without a translation', async () => {
    const { rows } = await brightRows(await renderQuoteImage(await quote(400, 100), null));
    expect([rows[0], rows.at(-1)]).toEqual([305, 404]);
  });

  it('scales down a large quote and keeps a long translation clear of it', async () => {
    const text = 'Un avorton dans ton genre devrait être reconnaissant de seulement pouvoir la porter. '.repeat(4);
    const { rows, info } = await brightRows(await renderQuoteImage(await quote(2000, 700), text));
    expect(info.height).toBe(710);
    const gap = rows.findIndex((y, index) => index > 0 && y - rows[index - 1] >= 30);
    expect(gap).toBeGreaterThan(0);
  });
});
