/**
 * Tests für services/image-studio.js — „Studio-Foto"-Pipeline.
 *
 * - Modell-Kette: Primärmodell ok → fertig; Primärmodell kaputt/dunkel → Fallback-Modell;
 *   beide kaputt → deterministischer Composite-Fallback (compositeOnGradient + shadow)
 * - Validierung verwirft zu kleine und zu dunkle Ergebnisse
 * - GCS-Upload-Fehler wirft NICHT, sondern liefert die Data-URL zurück
 *
 * CJS-Test — require.cache-Patching (kein vi.mock für CJS).
 */

const path = require('path');
const sharp = require('sharp');

require('./api/_patchGcp');

function patchLocalModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: mockExports,
    children: [],
    paths: [],
  };
}

const generateProductImagesSpy = vi.fn();
const fetchImageAsDataUrlSpy = vi.fn();
const uploadBase64ImageSpy = vi.fn();
const compositeOnGradientSpy = vi.fn();

patchLocalModule(path.resolve(__dirname, '../lib/vertex-ai.js'), {
  generateProductImages: generateProductImagesSpy,
});
patchLocalModule(path.resolve(__dirname, '../services/image-generation.js'), {
  fetchImageAsDataUrl: fetchImageAsDataUrlSpy,
});
patchLocalModule(path.resolve(__dirname, '../lib/storage.js'), {
  uploadBase64Image: uploadBase64ImageSpy,
});
patchLocalModule(path.resolve(__dirname, '../lib/background-removal.js'), {
  compositeOnGradient: compositeOnGradientSpy,
});

const { makeStudioPhoto, _internal } = require('../services/image-studio');

async function makePng({ size = 800, r = 250, g = 250, b = 250 }) {
  return sharp({ create: { width: size, height: size, channels: 3, background: { r, g, b } } })
    .png()
    .toBuffer();
}

let brightPng;
let darkPng;
let sourceDataUrl;

beforeAll(async () => {
  brightPng = await makePng({ r: 250, g: 250, b: 250 });
  darkPng = await makePng({ r: 20, g: 20, b: 22 });
  const sourceJpeg = await sharp({
    create: { width: 700, height: 700, channels: 3, background: { r: 128, g: 128, b: 128 } },
  })
    .jpeg()
    .toBuffer();
  sourceDataUrl = `data:image/jpeg;base64,${sourceJpeg.toString('base64')}`;
});

beforeEach(() => {
  generateProductImagesSpy.mockReset();
  fetchImageAsDataUrlSpy.mockReset();
  uploadBase64ImageSpy.mockReset();
  compositeOnGradientSpy.mockReset();

  fetchImageAsDataUrlSpy.mockImplementation(async () => sourceDataUrl);
  uploadBase64ImageSpy.mockResolvedValue({ url: 'https://storage.googleapis.com/test/studio.png', mimeType: 'image/png' });
  delete process.env.STUDIO_IMAGE_MODEL;
  delete process.env.STUDIO_IMAGE_FALLBACK_MODEL;
  delete process.env.GEMINI_IMAGE_MODEL;
});

describe('makeStudioPhoto — Modell-Kette', () => {
  it('nutzt das Primärmodell wenn es ein gültiges helles Bild liefert', async () => {
    generateProductImagesSpy.mockResolvedValue([{ base64: brightPng.toString('base64'), mimeType: 'image/png' }]);

    const result = await makeStudioPhoto({ productId: 'p1', image: { url_or_base64: 'https://x/img.jpg' } });

    expect(result.method).toBe('gemini');
    expect(result.model).toBe('gemini-3-pro-image-preview');
    expect(result.image.url_or_base64).toBe('https://storage.googleapis.com/test/studio.png');
    expect(result.image.source).toBe('studio_gemini');
    expect(generateProductImagesSpy).toHaveBeenCalledTimes(1);
    expect(generateProductImagesSpy.mock.calls[0][0].model).toBe('gemini-3-pro-image-preview');
    expect(compositeOnGradientSpy).not.toHaveBeenCalled();
  });

  it('fällt aufs Zweitmodell zurück wenn das Primärmodell wirft', async () => {
    generateProductImagesSpy
      .mockRejectedValueOnce(new Error('model not found'))
      .mockResolvedValueOnce([{ base64: brightPng.toString('base64'), mimeType: 'image/png' }]);

    const result = await makeStudioPhoto({ productId: 'p1', image: { url_or_base64: 'https://x/img.jpg' } });

    expect(result.method).toBe('gemini');
    expect(result.model).toBe('gemini-2.5-flash-image');
    expect(result.attempts).toEqual([
      expect.objectContaining({ model: 'gemini-3-pro-image-preview', reason: expect.stringContaining('model not found') }),
    ]);
  });

  it('verwirft ein zu dunkles Ergebnis (kein Studio-Hintergrund) und probiert das Zweitmodell', async () => {
    generateProductImagesSpy
      .mockResolvedValueOnce([{ base64: darkPng.toString('base64'), mimeType: 'image/png' }])
      .mockResolvedValueOnce([{ base64: brightPng.toString('base64'), mimeType: 'image/png' }]);

    const result = await makeStudioPhoto({ productId: 'p1', image: { url_or_base64: 'https://x/img.jpg' } });

    expect(result.method).toBe('gemini');
    expect(result.model).toBe('gemini-2.5-flash-image');
    expect(result.attempts[0].reason).toMatch(/background_too_dark/);
  });

  it('nutzt den Composite-Fallback (mit Schatten) wenn beide Modelle scheitern', async () => {
    generateProductImagesSpy.mockRejectedValue(new Error('api down'));
    compositeOnGradientSpy.mockResolvedValue({ buffer: brightPng, width: 1200, height: 1200 });

    const result = await makeStudioPhoto({ productId: 'p1', image: { url_or_base64: 'https://x/img.jpg' } });

    expect(result.method).toBe('composite_fallback');
    expect(result.model).toBeNull();
    expect(result.image.source).toBe('studio_composite');
    expect(compositeOnGradientSpy).toHaveBeenCalledTimes(1);
    expect(compositeOnGradientSpy.mock.calls[0][1]).toEqual(expect.objectContaining({ shadow: true }));
  });

  it('wirft NICHT bei GCS-Upload-Fehler, sondern liefert die Data-URL', async () => {
    generateProductImagesSpy.mockResolvedValue([{ base64: brightPng.toString('base64'), mimeType: 'image/png' }]);
    uploadBase64ImageSpy.mockRejectedValue(new Error('bucket unavailable'));

    const result = await makeStudioPhoto({ productId: 'p1', image: { url_or_base64: 'https://x/img.jpg' } });

    expect(result.image.url_or_base64).toMatch(/^data:image\/png;base64,/);
  });

  it('validiert Pflichtfelder', async () => {
    await expect(makeStudioPhoto({ productId: '', image: { url_or_base64: 'x' } })).rejects.toThrow(/productId/);
    await expect(makeStudioPhoto({ productId: 'p1', image: {} })).rejects.toThrow(/url_or_base64/);
  });
});

describe('validateStudioResult', () => {
  it('verwirft zu kleine Bilder', async () => {
    const tiny = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 250, g: 250, b: 250 } } })
      .png()
      .toBuffer();
    const verdict = await _internal.validateStudioResult(tiny);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/too_small/);
  });

  it('verwirft nicht dekodierbare Buffer', async () => {
    const verdict = await _internal.validateStudioResult(Buffer.from('kein bild'));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/decode_error/);
  });

  it('akzeptiert ein helles, ausreichend großes Bild', async () => {
    const verdict = await _internal.validateStudioResult(brightPng);
    expect(verdict).toEqual(expect.objectContaining({ ok: true, width: 800, height: 800 }));
  });
});
