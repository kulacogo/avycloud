/**
 * Regression test for the "AI-Varianten aus Referenz erzeugen" failure
 * (Incident 2026-07-09): our OWN public GCS product images were routed through
 * the BrightData Web Unlocker (a scraping proxy for bot-protected sites), which
 * errored for every reference → "Reference images could not be downloaded".
 *
 * Correct behaviour: a public/own image URL (GCS, CDN) must be fetched with a
 * plain GET; the Web Unlocker is only a fallback for hosts that block us.
 */

require('./api/_patchGcp');

function stubModule(modPath, exports) {
  try {
    const resolved = require.resolve(modPath);
    require.cache[resolved] = {
      id: resolved, filename: resolved, loaded: true,
      exports, children: [], paths: [],
    };
  } catch { /* not found — skip */ }
}

// Capture the unlocker spy so we can assert whether it was used.
const fetchWithUnlocker = vi.fn();

// Stub image-generation.js's heavy deps so requiring it is cheap + side-effect free.
stubModule('../lib/web-unlocker', { fetchWithUnlocker });
stubModule('../lib/vertex-ai', { generateProductImages: vi.fn() });
stubModule('../lib/storage', { uploadBase64Image: vi.fn() });
stubModule('../services/prompt-engine', { generateVisualDescriptions: vi.fn() });
stubModule('../lib/background-removal', { compositeOnGradient: vi.fn() });

const { fetchImageAsDataUrl } = require('../services/image-generation');

function jpegResponse({ ok = true, status = 200, contentType = 'image/jpeg', bytes = [0xff, 0xd8, 0xff, 0xe0] } = {}) {
  const buf = Buffer.from(bytes);
  return {
    ok,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

describe('fetchImageAsDataUrl — reference download', () => {
  beforeEach(() => {
    fetchWithUnlocker.mockReset();
    global.fetch = vi.fn();
  });

  it('downloads a public GCS image directly (plain GET), NOT via the Web Unlocker', async () => {
    global.fetch.mockResolvedValue(jpegResponse());

    const url = 'https://storage.googleapis.com/prodsandjobs/products/identify-uploads/v3_abc_0.jpeg';
    const dataUrl = await fetchImageAsDataUrl({ url_or_base64: url });

    expect(dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe(url);
    expect(fetchWithUnlocker).not.toHaveBeenCalled();
  });

  it('falls back to the Web Unlocker when the direct GET is blocked', async () => {
    global.fetch.mockResolvedValue(jpegResponse({ ok: false, status: 403 }));
    fetchWithUnlocker.mockResolvedValue({
      success: true,
      contentType: 'image/jpeg',
      body_base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64'),
    });

    const url = 'https://m.media-amazon.com/images/I/blocked.jpg';
    const dataUrl = await fetchImageAsDataUrl({ url_or_base64: url });

    expect(dataUrl).toMatch(/^data:image\/jpeg;base64,/);
    expect(fetchWithUnlocker).toHaveBeenCalledTimes(1);
  });

  it('decodes an inline data: URL without any network call', async () => {
    global.fetch.mockRejectedValue(new Error('should not be called'));
    const inline = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`;

    const dataUrl = await fetchImageAsDataUrl({ url_or_base64: inline });

    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(fetchWithUnlocker).not.toHaveBeenCalled();
  });
});
