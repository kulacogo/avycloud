'use strict';

const {
  TARGET_EDGE_PX,
  ANGLE_PRIORITY,
  VALID_ANGLES,
  upscaleImage,
  removeBackground,
  classifyImageAngle,
  rankImages,
  _internal,
} = require('../../lib/image-enhance');

const sharp = require('sharp');

async function makeJpeg(width, height, color = { r: 200, g: 200, b: 200 }) {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .jpeg({ quality: 80 })
    .toBuffer();
}

describe('image-enhance', () => {
  describe('constants', () => {
    it('TARGET_EDGE_PX is 1600', () => {
      expect(TARGET_EDGE_PX).toBe(1600);
    });

    it('ANGLE_PRIORITY ranks front highest', () => {
      expect(ANGLE_PRIORITY.front).toBe(0);
      expect(ANGLE_PRIORITY.unknown).toBeGreaterThan(ANGLE_PRIORITY.lifestyle);
    });

    it('VALID_ANGLES includes all priority keys', () => {
      for (const key of Object.keys(ANGLE_PRIORITY)) {
        expect(VALID_ANGLES).toContain(key);
      }
    });
  });

  describe('_internal.getSharp', () => {
    it('returns the sharp module when available', () => {
      expect(_internal.getSharp()).toBeTruthy();
    });
  });

  describe('upscaleImage', () => {
    it('returns invalid_buffer for non-Buffer input', async () => {
      const res = await upscaleImage(null);
      expect(res.upscaled).toBe(false);
      expect(res.reason).toBe('invalid_buffer');
    });

    it('skips upscaling when already close to target edge', async () => {
      const buf = await makeJpeg(1500, 1200);
      const res = await upscaleImage(buf);
      expect(res.upscaled).toBe(false);
      expect(res.reason).toBe('already_sufficient');
    });

    it('upscales a small 400x300 image to target edge 1600', async () => {
      const buf = await makeJpeg(400, 300);
      const res = await upscaleImage(buf);
      expect(res.upscaled).toBe(true);
      expect(res.width).toBe(TARGET_EDGE_PX);
      expect(res.height).toBe(Math.round((300 * TARGET_EDGE_PX) / 400));
      expect(res.buffer.length).toBeGreaterThan(0);
    });

    it('respects a custom targetEdge', async () => {
      const buf = await makeJpeg(400, 300);
      const res = await upscaleImage(buf, { targetEdge: 800 });
      expect(res.upscaled).toBe(true);
      expect(res.width).toBe(800);
    });
  });

  describe('removeBackground', () => {
    it('returns no_gemini_client when client missing', async () => {
      const buf = Buffer.from('fake');
      const res = await removeBackground(buf);
      expect(res.modified).toBe(false);
      expect(res.reason).toBe('no_gemini_client');
    });

    it('returns invalid_buffer for null input', async () => {
      const res = await removeBackground(null);
      expect(res.modified).toBe(false);
      expect(res.reason).toBe('invalid_buffer');
    });

    it('returns modified buffer when gemini responds', async () => {
      const originalBuf = Buffer.from('original-content-longer-than-100bytes'.padEnd(200, 'x'));
      const fakeClient = {
        generateImage: async () => ({
          image: { inlineData: { data: Buffer.from('new-image-content'.padEnd(200, 'y')).toString('base64') } },
        }),
      };
      const res = await removeBackground(originalBuf, { geminiClient: fakeClient });
      expect(res.modified).toBe(true);
      expect(res.buffer).not.toEqual(originalBuf);
      expect(res.reason).toBe('gemini_image_preview');
    });

    it('returns original buffer when gemini response has no image', async () => {
      const buf = Buffer.from('x'.repeat(200));
      const fakeClient = { generateImage: async () => ({ image: {} }) };
      const res = await removeBackground(buf, { geminiClient: fakeClient });
      expect(res.modified).toBe(false);
      expect(res.buffer).toBe(buf);
    });

    it('returns original buffer when gemini throws', async () => {
      const buf = Buffer.from('x'.repeat(200));
      const fakeClient = {
        generateImage: async () => {
          throw new Error('API down');
        },
      };
      const res = await removeBackground(buf, { geminiClient: fakeClient });
      expect(res.modified).toBe(false);
      expect(res.reason).toContain('gemini_error');
    });

    it('returns original when output is too small', async () => {
      const buf = Buffer.from('x'.repeat(200));
      const fakeClient = {
        generateImage: async () => ({
          image: { inlineData: { data: Buffer.from('tiny').toString('base64') } },
        }),
      };
      const res = await removeBackground(buf, { geminiClient: fakeClient });
      expect(res.modified).toBe(false);
      expect(res.reason).toBe('output_too_small');
    });
  });

  describe('classifyImageAngle', () => {
    it('returns unknown when no client', async () => {
      const res = await classifyImageAngle({ inlineData: { data: 'x', mimeType: 'image/jpeg' } });
      expect(res.angle).toBe('unknown');
      expect(res.confidence).toBe(0);
    });

    it('returns unknown for invalid part', async () => {
      const res = await classifyImageAngle(null);
      expect(res.angle).toBe('unknown');
      expect(res.reason).toBe('invalid_part');
    });

    it('parses valid gemini response', async () => {
      const fakeClient = {
        generateContent: async () => ({
          text: JSON.stringify({ angle: 'front', confidence: 0.92 }),
        }),
      };
      const res = await classifyImageAngle(
        { inlineData: { data: 'x', mimeType: 'image/jpeg' } },
        { geminiClient: fakeClient }
      );
      expect(res.angle).toBe('front');
      expect(res.confidence).toBeCloseTo(0.92);
    });

    it('falls back to unknown for invalid angle value', async () => {
      const fakeClient = {
        generateContent: async () => ({
          text: JSON.stringify({ angle: 'moon-view', confidence: 0.9 }),
        }),
      };
      const res = await classifyImageAngle(
        { inlineData: { data: 'x', mimeType: 'image/jpeg' } },
        { geminiClient: fakeClient }
      );
      expect(res.angle).toBe('unknown');
    });

    it('clamps confidence to 0..1', async () => {
      const fakeClient = {
        generateContent: async () => ({
          text: JSON.stringify({ angle: 'front', confidence: 1.5 }),
        }),
      };
      const res = await classifyImageAngle(
        { inlineData: { data: 'x', mimeType: 'image/jpeg' } },
        { geminiClient: fakeClient }
      );
      expect(res.confidence).toBe(1);
    });

    it('handles thrown errors gracefully', async () => {
      const fakeClient = {
        generateContent: async () => {
          throw new Error('timeout');
        },
      };
      const res = await classifyImageAngle(
        { inlineData: { data: 'x', mimeType: 'image/jpeg' } },
        { geminiClient: fakeClient }
      );
      expect(res.angle).toBe('unknown');
      expect(res.reason).toContain('classify_error');
    });
  });

  describe('rankImages', () => {
    it('returns [] for non-array input', () => {
      expect(rankImages(null)).toEqual([]);
    });

    it('sorts front before detail before back', () => {
      const out = rankImages([
        { angle: 'back', quality: 0.9 },
        { angle: 'front', quality: 0.9 },
        { angle: 'detail', quality: 0.9 },
      ]);
      expect(out.map((i) => i.angle)).toEqual(['front', 'detail', 'back']);
    });

    it('within same angle, higher quality first', () => {
      const out = rankImages([
        { angle: 'front', quality: 0.5 },
        { angle: 'front', quality: 0.9 },
        { angle: 'front', quality: 0.7 },
      ]);
      expect(out.map((i) => i.quality)).toEqual([0.9, 0.7, 0.5]);
    });

    it('within same angle + quality, upload source beats web', () => {
      const out = rankImages([
        { angle: 'front', quality: 0.8, source: 'web' },
        { angle: 'front', quality: 0.8, source: 'upload' },
      ]);
      expect(out[0].source).toBe('upload');
    });

    it('treats missing angle as unknown (lowest priority)', () => {
      const out = rankImages([{}, { angle: 'front' }]);
      expect(out[0].angle).toBe('front');
    });
  });
});
