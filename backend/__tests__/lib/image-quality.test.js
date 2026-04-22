'use strict';

const sharp = require('sharp');

const {
  analyzeImage,
  analyzeBackground,
  filterImagesByQuality,
  MIN_WIDTH,
  MIN_HEIGHT,
  MAX_IMAGES,
} = require('../../lib/image-quality');

async function createBuffer(width, height, r = 255, g = 255, b = 255) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r, g, b },
    },
  })
    .jpeg()
    .toBuffer();
}

describe('analyzeImage', () => {
  it('reports meetsMinResolution=true for 800x800 buffer', async () => {
    const buf = await createBuffer(800, 800);
    const result = await analyzeImage(buf);

    expect(result.width).toBe(800);
    expect(result.height).toBe(800);
    expect(result.meetsMinResolution).toBe(true);
    expect(result.meetsRecommendedResolution).toBe(false);
    expect(result.issues).not.toContain('low_resolution');
  });

  it('reports meetsMinResolution=false for 300x300 buffer and adds issue', async () => {
    const buf = await createBuffer(300, 300);
    const result = await analyzeImage(buf);

    expect(result.meetsMinResolution).toBe(false);
    expect(result.issues).toContain('low_resolution');
    expect(result.width).toBe(300);
    expect(result.height).toBe(300);
  });

  it('reports meetsRecommendedResolution=true for 1500x1500 buffer', async () => {
    const buf = await createBuffer(1500, 1500);
    const result = await analyzeImage(buf);

    expect(result.meetsMinResolution).toBe(true);
    expect(result.meetsRecommendedResolution).toBe(true);
  });

  it('includes pixelCount, aspectRatio, and qualityScore', async () => {
    const buf = await createBuffer(800, 600);
    const result = await analyzeImage(buf);

    expect(result.pixelCount).toBe(800 * 600);
    expect(result.aspectRatio).toBeCloseTo(800 / 600, 3);
    expect(result.qualityScore).toBeGreaterThan(0);
    expect(result.qualityScore).toBeLessThanOrEqual(1);
  });

  it('returns perceptual hash (16 hex chars) by default', async () => {
    const buf = await createBuffer(600, 600, 128, 128, 128);
    const result = await analyzeImage(buf);

    expect(result.hash).toBeTruthy();
    expect(result.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('skips hash when computeHash=false', async () => {
    const buf = await createBuffer(600, 600);
    const result = await analyzeImage(buf, { computeHash: false });
    expect(result.hash).toBe('');
  });

  it('same buffer produces same hash (stable)', async () => {
    const buf = await createBuffer(600, 600, 64, 192, 32);
    const r1 = await analyzeImage(buf);
    const r2 = await analyzeImage(buf);
    expect(r1.hash).toBe(r2.hash);
    expect(r1.hash.length).toBe(16);
  });

  it('different images produce different hashes', async () => {
    // Use gradient-like synthetic images by varying raw pixel data so the aHash differs.
    const bufA = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .composite([
        {
          input: Buffer.from(
            Array.from({ length: 32 * 32 * 3 }, (_, i) => (i % 3 === 0 ? 240 : 20)),
          ),
          raw: { width: 32, height: 32, channels: 3 },
          top: 0,
          left: 0,
        },
      ])
      .jpeg()
      .toBuffer();

    const bufB = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 250, g: 250, b: 250 } },
    })
      .composite([
        {
          input: Buffer.from(
            Array.from({ length: 32 * 32 * 3 }, (_, i) => (i % 3 === 0 ? 10 : 240)),
          ),
          raw: { width: 32, height: 32, channels: 3 },
          top: 32,
          left: 32,
        },
      ])
      .jpeg()
      .toBuffer();

    const rA = await analyzeImage(bufA);
    const rB = await analyzeImage(bufB);
    expect(rA.hash).not.toBe(rB.hash);
  });

  it('returns issues=["invalid_buffer"] for empty buffer', async () => {
    const result = await analyzeImage(Buffer.alloc(0));
    expect(result.issues).toContain('invalid_buffer');
    expect(result.meetsMinResolution).toBe(false);
  });

  it('returns decode_failed for non-image bytes', async () => {
    const garbage = Buffer.from('not an image at all', 'utf8');
    const result = await analyzeImage(garbage);
    expect(result.issues).toContain('decode_failed');
    expect(result.qualityScore).toBe(0);
  });
});

describe('analyzeBackground', () => {
  it('classifies pure white buffer as type=white with score=1.0', () => {
    const width = 32;
    const height = 32;
    const channels = 3;
    const raw = Buffer.alloc(width * height * channels, 255);
    const result = analyzeBackground(raw, { width, height, channels });

    expect(result.backgroundType).toBe('white');
    expect(result.backgroundScore).toBe(1.0);
  });

  it('classifies strongly-colored buffer with high variance as colored', () => {
    const width = 32;
    const height = 32;
    const channels = 3;
    const raw = Buffer.alloc(width * height * channels);
    // Corner 1 (top-left 10x10) → red, Corner 2 (top-right) → green,
    // Corner 3 (bottom-left) → blue, Corner 4 (bottom-right) → yellow.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * channels;
        let r = 0;
        let g = 0;
        let b = 0;
        if (x < 10 && y < 10) { r = 255; }
        else if (x >= width - 10 && y < 10) { g = 255; }
        else if (x < 10 && y >= height - 10) { b = 255; }
        else if (x >= width - 10 && y >= height - 10) { r = 255; g = 255; }
        raw[idx] = r;
        raw[idx + 1] = g;
        raw[idx + 2] = b;
      }
    }
    const result = analyzeBackground(raw, { width, height, channels });
    expect(result.backgroundType).toBe('colored');
    expect(result.backgroundScore).toBeLessThan(0.5);
  });

  it('classifies neutral gray buffer as type=neutral', () => {
    const width = 32;
    const height = 32;
    const channels = 3;
    const raw = Buffer.alloc(width * height * channels, 200);
    const result = analyzeBackground(raw, { width, height, channels });
    expect(result.backgroundType).toBe('neutral');
    expect(result.backgroundScore).toBeGreaterThan(0.5);
  });

  it('returns unknown for undersized buffers', () => {
    const result = analyzeBackground(Buffer.alloc(3), { width: 1, height: 1, channels: 3 });
    expect(result.backgroundType).toBe('unknown');
  });
});

describe('filterImagesByQuality', () => {
  it('deduplicates by hash (keeps first occurrence)', () => {
    const images = [
      { url: 'a.jpg', analysis: { hash: 'abc', qualityScore: 0.9 } },
      { url: 'b.jpg', analysis: { hash: 'abc', qualityScore: 0.8 } }, // dup
      { url: 'c.jpg', analysis: { hash: 'def', qualityScore: 0.7 } },
    ];
    const result = filterImagesByQuality(images);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.url)).toContain('a.jpg');
    expect(result.map((r) => r.url)).toContain('c.jpg');
    expect(result.map((r) => r.url)).not.toContain('b.jpg');
  });

  it('filters out images below minQualityScore', () => {
    const images = [
      { url: 'good.jpg', analysis: { hash: '1', qualityScore: 0.8 } },
      { url: 'bad.jpg', analysis: { hash: '2', qualityScore: 0.2 } },
    ];
    const result = filterImagesByQuality(images, { minQualityScore: 0.5 });
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('good.jpg');
  });

  it('respects maxImages cap and sorts by qualityScore desc', () => {
    const images = Array.from({ length: 20 }, (_, i) => ({
      url: `img-${i}.jpg`,
      analysis: { hash: String(i), qualityScore: 0.5 + (i * 0.01) },
    }));
    const result = filterImagesByQuality(images, { maxImages: 5 });
    expect(result).toHaveLength(5);
    // Highest scores first
    expect(result[0].analysis.qualityScore).toBeGreaterThan(result[4].analysis.qualityScore);
    // Top item should be the highest scored (i=19)
    expect(result[0].url).toBe('img-19.jpg');
  });

  it('returns empty array for non-array input', () => {
    expect(filterImagesByQuality(null)).toEqual([]);
    expect(filterImagesByQuality(undefined)).toEqual([]);
    expect(filterImagesByQuality('string')).toEqual([]);
  });

  it('uses url as dedup key when hash is missing', () => {
    const images = [
      { url: 'same.jpg', analysis: { qualityScore: 0.9 } },
      { url: 'same.jpg', analysis: { qualityScore: 0.5 } }, // dup url
      { url: 'other.jpg', analysis: { qualityScore: 0.7 } },
    ];
    const result = filterImagesByQuality(images, { minQualityScore: 0 });
    expect(result).toHaveLength(2);
  });

  it('default cap is MAX_IMAGES', () => {
    const images = Array.from({ length: MAX_IMAGES + 5 }, (_, i) => ({
      url: `i-${i}.jpg`,
      analysis: { hash: String(i), qualityScore: 0.9 },
    }));
    const result = filterImagesByQuality(images);
    expect(result.length).toBeLessThanOrEqual(MAX_IMAGES);
    expect(result).toHaveLength(MAX_IMAGES);
  });
});

describe('constants', () => {
  it('exports expected thresholds', () => {
    expect(MIN_WIDTH).toBe(500);
    expect(MIN_HEIGHT).toBe(500);
    expect(MAX_IMAGES).toBeGreaterThanOrEqual(1);
  });
});
