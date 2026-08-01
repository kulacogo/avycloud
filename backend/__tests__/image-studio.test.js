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
    expect(result.model).toBe('gemini-2.5-flash-image');
    expect(result.image.url_or_base64).toBe('https://storage.googleapis.com/test/studio.png');
    expect(result.image.source).toBe('studio_gemini');
    expect(generateProductImagesSpy).toHaveBeenCalledTimes(1);
    expect(generateProductImagesSpy.mock.calls[0][0].model).toBe('gemini-2.5-flash-image');
    expect(compositeOnGradientSpy).not.toHaveBeenCalled();
  });

  // Seit dem 2.5-Downgrade sind Default-Primär- und Fallback-Modell identisch
  // (Kette dedupliziert auf EIN Modell). Die Ketten-MECHANIK bleibt und wird
  // hier mit expliziten ENV-Modellen getestet.
  it('fällt aufs Zweitmodell zurück wenn das Primärmodell wirft', async () => {
    process.env.STUDIO_IMAGE_MODEL = 'studio-primary-test';
    process.env.STUDIO_IMAGE_FALLBACK_MODEL = 'gemini-2.5-flash-image';
    generateProductImagesSpy
      .mockRejectedValueOnce(new Error('model not found'))
      .mockResolvedValueOnce([{ base64: brightPng.toString('base64'), mimeType: 'image/png' }]);

    const result = await makeStudioPhoto({ productId: 'p1', image: { url_or_base64: 'https://x/img.jpg' } });

    expect(result.method).toBe('gemini');
    expect(result.model).toBe('gemini-2.5-flash-image');
    expect(result.attempts).toEqual([
      expect.objectContaining({ model: 'studio-primary-test', reason: expect.stringContaining('model not found') }),
    ]);
  });

  it('verwirft ein zu dunkles Ergebnis (kein Studio-Hintergrund) und probiert das Zweitmodell', async () => {
    process.env.STUDIO_IMAGE_MODEL = 'studio-primary-test';
    process.env.STUDIO_IMAGE_FALLBACK_MODEL = 'gemini-2.5-flash-image';
    generateProductImagesSpy
      .mockResolvedValueOnce([{ base64: darkPng.toString('base64'), mimeType: 'image/png' }])
      .mockResolvedValueOnce([{ base64: brightPng.toString('base64'), mimeType: 'image/png' }]);

    const result = await makeStudioPhoto({ productId: 'p1', image: { url_or_base64: 'https://x/img.jpg' } });

    expect(result.method).toBe('gemini');
    expect(result.model).toBe('gemini-2.5-flash-image');
    expect(result.attempts[0].reason).toMatch(/background_too_dark/);
  });

  it('nutzt den sicheren Weiß-Fallback (Produkt zentriert, KEIN Freisteller) wenn beide Modelle scheitern', async () => {
    generateProductImagesSpy.mockRejectedValue(new Error('api down'));

    const result = await makeStudioPhoto({ productId: 'p1', image: { url_or_base64: 'https://x/img.jpg' } });

    expect(result.method).toBe('composite_fallback');
    expect(result.model).toBeNull();
    expect(result.image.source).toBe('studio_composite');
    // Ergebnis ist ein gültiges Bild (hochgeladen) — der Fallback stellt NICHT frei
    // (Incident 2026-07-18: Freisteller zerschmierte helle/metallische Produkte).
    expect(uploadBase64ImageSpy).toHaveBeenCalledTimes(1);
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

describe('STUDIO_PROMPT — reinweißer Hintergrund (kein Verlauf)', () => {
  it('fordert reines Weiß und verbietet Verlauf/Off-White', () => {
    const p = _internal.STUDIO_PROMPT.toLowerCase();
    expect(p).toContain('pure white');
    expect(p).toContain('#ffffff');
    expect(p).toContain('no gradient');
    expect(p).not.toContain('off-white with a very');
  });
});

describe('padOnWhiteSquare — sicherer Weiß-Fallback (kein Freisteller)', () => {
  it('zentriert ein helles Produkt intakt auf reinweißem Quadrat (Ecken 255, Produkt überlebt)', async () => {
    // Helles Produkt (metallik-artig, ~220 grau) auf weißem Hintergrund — der
    // alte Freisteller hätte es zerstört; padOnWhiteSquare lässt es intakt.
    const product = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).composite([{
      input: await sharp({ create: { width: 220, height: 220, channels: 3, background: { r: 210, g: 212, b: 216 } } }).png().toBuffer(),
      left: 90, top: 90,
    }]).jpeg().toBuffer();

    const out = await _internal.padOnWhiteSquare(product, 600);
    expect(out.width).toBe(600);
    const { data, info } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
    const px = (x, y) => { const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; };
    // Ecken reinweiß
    for (const [x, y] of [[3, 3], [info.width - 4, 3], [3, info.height - 4], [info.width - 4, info.height - 4]]) {
      expect(px(x, y)).toEqual([255, 255, 255]);
    }
    // Produkt überlebt: die Bildmitte ist NICHT weiß (das helle Produkt ist da)
    const [cr, cg, cb] = px(Math.round(info.width / 2), Math.round(info.height / 2));
    expect(cr < 245 || cg < 245 || cb < 245).toBe(true);
  });
});
