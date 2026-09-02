/**
 * Integration-Tests: POST /api/images/studio (Studio-Foto)
 *
 * - 200 + Ergebnis-Shape, Payload wird an makeStudioPhoto durchgereicht
 * - 400 bei fehlendem productId / image
 * - 500 wenn der Service wirft
 *
 * CJS-Test — require.cache-Patching (kein vi.mock für CJS).
 */

const request = require('supertest');
const path = require('path');

require('./_patchGcp');

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

const makeStudioPhotoSpy = vi.fn();
patchLocalModule(path.resolve(__dirname, '../../services/image-studio.js'), {
  makeStudioPhoto: makeStudioPhotoSpy,
});

require('./_patchLocalModules');
require('./_setupMocks');
const { createTestApp } = require('./_createApp');
const { router: productsRouter } = require('../../routes/products');

const app = createTestApp(productsRouter);

const SAMPLE_RESULT = {
  image: {
    url_or_base64: 'https://storage.googleapis.com/test/studio.png',
    variant: 'studio_front',
    source: 'studio_gemini',
    notes: 'Studio-Foto (KI)',
    mimeType: 'image/png',
    width: 1024,
    height: 1024,
  },
  method: 'gemini',
  model: 'gemini-3-pro-image-preview',
  attempts: [],
};

describe('POST /api/images/studio', () => {
  beforeEach(() => makeStudioPhotoSpy.mockReset());

  it('liefert 200 mit dem Studio-Ergebnis und reicht die Payload durch', async () => {
    makeStudioPhotoSpy.mockResolvedValue(SAMPLE_RESULT);

    const res = await request(app)
      .post('/api/images/studio')
      .send({ productId: 'SKU-123', image: { url_or_base64: 'https://x/img.jpg' } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.image.url_or_base64).toBe('https://storage.googleapis.com/test/studio.png');
    // objectContaining statt exakter Gleichheit: die Route reicht seit 2026-09-02
    // zusaetzlich `siblingImages` durch (weitere ECHTE Fotos desselben Artikels als
    // Identitaetsanker). Das ist additiv — der Test soll den Durchreich-Vertrag
    // pruefen, nicht die Parameterliste einfrieren.
    expect(makeStudioPhotoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'SKU-123',
        image: { url_or_base64: 'https://x/img.jpg' },
      })
    );
  });

  it('liefert 400 ohne productId', async () => {
    const res = await request(app)
      .post('/api/images/studio')
      .send({ image: { url_or_base64: 'https://x/img.jpg' } });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(makeStudioPhotoSpy).not.toHaveBeenCalled();
  });

  it('liefert 400 ohne image.url_or_base64', async () => {
    const res = await request(app).post('/api/images/studio').send({ productId: 'SKU-123', image: {} });

    expect(res.status).toBe(400);
    expect(makeStudioPhotoSpy).not.toHaveBeenCalled();
  });

  it('degradiert zu 500 wenn im Route-Try etwas wirft (crasht nie)', async () => {
    // Ein zirkuläres Ergebnis lässt res.json() synchron im Try werfen → Catch → 500.
    // (Eine Mock-Rejection/-Exception im Test-File löst hier einen Vitest-
    // Unhandled-Error-False-Positive aus, obwohl die Route sauber catcht —
    // gleiches Pattern wie admin-financials.test.js.)
    const circular = { image: {} };
    circular.image.self = circular;
    makeStudioPhotoSpy.mockResolvedValue(circular);

    const res = await request(app)
      .post('/api/images/studio')
      .send({ productId: 'SKU-123', image: { url_or_base64: 'https://x/img.jpg' } });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.details).toMatch(/circular/i);
  });
});
