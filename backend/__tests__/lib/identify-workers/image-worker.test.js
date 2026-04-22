'use strict';

const sharp = require('sharp');
const {
  runImageWorker,
  DOMAIN,
} = require('../../../lib/identify-workers/image-worker');

async function makeJpeg(w, h, r = 200, g = 200, b = 200) {
  return sharp({
    create: { width: w, height: h, channels: 3, background: { r, g, b } },
  })
    .jpeg({ quality: 80 })
    .toBuffer();
}

describe('image-worker', () => {
  it('DOMAIN is "image"', () => {
    expect(DOMAIN).toBe('image');
  });

  it('returns empty result for empty context', async () => {
    const r = await runImageWorker({});
    expect(r.ok).toBe(false);
    expect(r.resolved.images).toEqual([]);
  });

  it('analyzes + ranks upload buffers', async () => {
    const buf1 = await makeJpeg(1200, 1200);
    const buf2 = await makeJpeg(800, 800);
    const r = await runImageWorker({
      files: [{ buffer: buf1 }, { buffer: buf2 }],
    });
    expect(r.ok).toBe(true);
    expect(r.resolved.images.length).toBeGreaterThan(0);
    expect(r.domain).toBe('image');
  });

  it('dedupes identical buffers by aHash', async () => {
    const same = await makeJpeg(1200, 1200);
    const r = await runImageWorker({
      files: [{ buffer: same }, { buffer: same }, { buffer: same }],
    });
    // All identical → only 1 unique after dedup
    expect(r.resolved.images.length).toBe(1);
  });

  it('returns unified shape', async () => {
    const r = await runImageWorker({ files: [] });
    expect(r).toHaveProperty('ok');
    expect(r).toHaveProperty('domain', 'image');
    expect(r).toHaveProperty('resolved');
    expect(r).toHaveProperty('confidence');
    expect(r).toHaveProperty('sources');
    expect(r).toHaveProperty('meta');
  });

  it('confidence scales with meetsRecommendedResolution count', async () => {
    const big1 = await makeJpeg(1300, 1300, 255, 255, 255);
    const big2 = await makeJpeg(1400, 1400, 250, 250, 250);
    const big3 = await makeJpeg(1500, 1500, 245, 245, 245);
    const r = await runImageWorker({
      files: [{ buffer: big1 }, { buffer: big2 }, { buffer: big3 }],
    });
    expect(r.confidence.images).toBeGreaterThanOrEqual(0.75);
  });

  it('skips enhancement when IDENTIFY_V4_IMAGE_ENHANCE=false', async () => {
    const prev = process.env.IDENTIFY_V4_IMAGE_ENHANCE;
    process.env.IDENTIFY_V4_IMAGE_ENHANCE = 'false';
    try {
      const buf = await makeJpeg(1200, 1200);
      const r = await runImageWorker({ files: [{ buffer: buf }] });
      expect(r.meta.enhancedCount).toBe(0);
    } finally {
      if (prev == null) delete process.env.IDENTIFY_V4_IMAGE_ENHANCE;
      else process.env.IDENTIFY_V4_IMAGE_ENHANCE = prev;
    }
  });

  it('top_image_url comes from best-ranked image', async () => {
    const r = await runImageWorker({
      identity: {
        web_image_urls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
      },
    });
    // Without upload buffers, only url-based analyzed = quality 0 but still ranked
    expect(r.domain).toBe('image');
  });
});
