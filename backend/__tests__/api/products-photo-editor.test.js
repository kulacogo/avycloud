const request = require('supertest');
require('./_patchGcp');
const { spies: local } = require('./_patchLocalModules');
const { spies: dataSpies } = require('./_setupMocks');
const upload = vi.fn();
require('../../lib/storage').uploadPhotoEditorAsset = upload;
const { createTestApp } = require('./_createApp');
const app = createTestApp(require('../../routes/products').router);
const own = (role) => `https://storage.googleapis.com/prodsandjobs/products/p/${role}.png`;
const inline = 'data:image/png;base64,aGVsbG8=';
const photo = () => ({ source: 'generated', notes: 'Gemini Studio', generatedByAi: true, derivedFrom: 'https://example.com/source.jpg',
  url_or_base64: inline, photoEditor: { version: 1, originalUrl: inline, originalMimeType: 'image/png', maskUrl: inline,
    recipe: { exposure: 0.2 }, updatedAt: '2026-09-27T12:00:00.000Z' } });
const product = () => ({ id: 'p', identification: { name: 'Fotoartikel', sku: 'p' }, details: { images: [photo()], attributes: {} } });

describe('POST /api/save preserves reversible photo edits', () => {
  let persisted;
  beforeEach(() => {
    persisted = product();
    upload.mockReset().mockImplementation(async (_data, _id, role) => ({ url: own(role), mimeType: 'image/png', width: 2400, height: 1800 }));
    dataSpies.getProduct.mockReset().mockImplementation(async () => persisted);
    local.saveProductV2.mockReset().mockImplementation(async (value) => { persisted = JSON.parse(JSON.stringify(value)); return persisted; });
    local.uploadBase64Image.mockClear();
  });
  it('writes durable originals/masks/result and round-trips metadata on the real read route', async () => {
    const response = await request(app).post('/api/save').send(product());
    expect(response.status).toBe(200);
    expect(local.saveProductV2).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(persisted)).not.toContain('data:');
    expect(local.uploadBase64Image).not.toHaveBeenCalled();
    const loaded = await request(app).get('/api/products/p');
    expect(loaded.status).toBe(200);
    expect(loaded.body.product.details.images[0]).toMatchObject({ source: 'generated', notes: 'Gemini Studio', generatedByAi: true,
      derivedFrom: 'https://example.com/source.jpg', url_or_base64: own('render'), photoEditor: { originalUrl: own('original'), maskUrl: own('mask'), recipe: { exposure: 0.2 } } });
  });
  it.each(['original', 'mask', 'render'])('does not write a product when %s upload fails', async (failRole) => {
    upload.mockImplementation(async (_data, _id, role) => {
      if (role === failRole) throw new Error('unavailable');
      return { url: own(role), mimeType: 'image/png' };
    });
    const response = await request(app).post('/api/save').send(product());
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('PHOTO_EDITOR_UPLOAD_FAILED');
    expect(local.saveProductV2).not.toHaveBeenCalled();
  });
  it('validates every editor image before uploading any asset', async () => {
    const input = product();
    input.details.images.push(photo());
    input.details.images[1].photoEditor.originalUrl = 'https://example.org/not-durable.png';
    const response = await request(app).post('/api/save').send(input);
    expect(response.status).toBe(422);
    expect(upload).not.toHaveBeenCalled();
    expect(local.saveProductV2).not.toHaveBeenCalled();
  });
});
