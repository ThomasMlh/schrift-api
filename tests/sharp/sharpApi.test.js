import sharp from 'sharp';

// Smoke tests covering exactly the sharp API surface used by the OCR pipeline
// (src/utils/ocrAutoDetect.js, src/utils/ocrProcessor.js, routes/ocr.js, routes/ocr-debug.js), so
// every call used in production keeps behaving as expected after sharp upgrades.
//
// The test image is generated in memory (no external fixture): 100x60 px, a white rectangle on a
// black background, giving contrast to measure with stats().
const makeTestImage = async () => {
  const width = 100;
  const height = 60;
  const channels = 3;
  const buffer = Buffer.alloc(width * height * channels, 0); // Black everywhere

  // White rectangle in the middle
  for (let y = 20; y < 40; y++) {
    for (let x = 25; x < 75; x++) {
      const idx = (y * width + x) * channels;
      buffer[idx] = 255;
      buffer[idx + 1] = 255;
      buffer[idx + 2] = 255;
    }
  }

  return sharp(buffer, { raw: { width, height, channels } }).png().toBuffer();
};

describe('sharp API surface used by the OCR pipeline', () => {
  it('metadata() returns width/height', async () => {
    const image = await makeTestImage();
    const meta = await sharp(image).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(60);
  });

  it('resize() with kernel as an object (sharp.kernel.lanczos3), matching ocrAutoDetect.js', async () => {
    const image = await makeTestImage();
    const resized = await sharp(image)
      .resize(null, 120, { withoutEnlargement: false, kernel: sharp.kernel.lanczos3 })
      .png()
      .toBuffer();
    const meta = await sharp(resized).metadata();
    expect(meta.height).toBe(120);
  });

  it('resize() with kernel as a string, matching ocrProcessor.js', async () => {
    const image = await makeTestImage();
    const resized = await sharp(image)
      .resize(200, 120, { kernel: 'lanczos3' })
      .png()
      .toBuffer();
    const meta = await sharp(resized).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(120);
  });

  it('greyscale + normalize + sharpen + png + toBuffer chain, matching preprocessForScores', async () => {
    const image = await makeTestImage();
    const processed = await sharp(image)
      .resize(null, 100, { withoutEnlargement: false, kernel: sharp.kernel.lanczos3 })
      .greyscale()
      .normalize()
      .sharpen({ sigma: 1.0 })
      .png()
      .toBuffer();
    expect(Buffer.isBuffer(processed)).toBe(true);
    expect(processed.length).toBeGreaterThan(0);
  });

  it('extract + resize + greyscale + linear + normalize + threshold, matching preprocessRegion', async () => {
    const image = await makeTestImage();
    const processed = await sharp(image)
      .extract({ left: 10, top: 10, width: 50, height: 30 })
      .resize(100, 60, { kernel: 'lanczos3' })
      .greyscale()
      .linear(1.5, -(128 * 0.5))
      .normalize()
      .threshold(140)
      .toBuffer();
    expect(Buffer.isBuffer(processed)).toBe(true);
    const meta = await sharp(processed).metadata();
    expect(meta.width).toBe(100);
    expect(meta.height).toBe(60);
  });

  it('threshold + negate, matching the inverted name-crop preprocessing', async () => {
    const image = await makeTestImage();
    const processed = await sharp(image)
      .threshold(200)
      .negate()
      .resize(null, 80, { withoutEnlargement: false, kernel: sharp.kernel.lanczos3 })
      .toBuffer();
    expect(Buffer.isBuffer(processed)).toBe(true);
  });

  it('extract + png + toBuffer, matching the raw name-crop extraction', async () => {
    const image = await makeTestImage();
    const crop = await sharp(image).extract({ left: 25, top: 20, width: 50, height: 20 }).png().toBuffer();
    const meta = await sharp(crop).metadata();
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(20);
  });

  it('stats() exposes channels[0].stdev, used to detect empty/uniform crops', async () => {
    const image = await makeTestImage();
    const stats = await sharp(image).stats();
    expect(stats.channels[0]).toHaveProperty('stdev');
    expect(typeof stats.channels[0].stdev).toBe('number');
    // The image has a sharp contrast (white rectangle on black): stdev > 0.
    expect(stats.channels[0].stdev).toBeGreaterThan(0);
  });

  it('stats() on a perfectly uniform image reports ~0 stdev (the "no text" detection path)', async () => {
    const flat = await sharp(Buffer.alloc(30 * 30 * 3, 128), { raw: { width: 30, height: 30, channels: 3 } })
      .png()
      .toBuffer();
    const stats = await sharp(flat).stats();
    expect(stats.channels[0].stdev).toBeLessThan(1);
  });
});
