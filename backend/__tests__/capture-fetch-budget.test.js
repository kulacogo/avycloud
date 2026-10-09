'use strict';
const webPath = require.resolve('../lib/web-search-html');
require(webPath);
const fetchText = vi.fn();
require.cache[webPath] = { id: webPath, filename: webPath, loaded: true, exports: { fetchText, htmlToText: text => text } };
const { fetchPageForVerification } = require('../lib/price-evidence');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('does not start a second network request after the first consumed the whole page budget', async () => {
  let now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  fetchText.mockImplementationOnce(async () => { now += 6000; return { ok: false, status: 503 }; });
  const direct = vi.fn(); vi.stubGlobal('fetch', direct);
  const result = await fetchPageForVerification('https://shop.example.de/product', { timeoutMs: 6000 });
  expect(result).toMatchObject({ ok: false, via: 'deadline' });
  expect(direct).not.toHaveBeenCalled();
});
it('still reads a direct page when the unavailable unlocker leaves sufficient budget', async () => {
  fetchText.mockResolvedValueOnce({ ok: false, status: 0 });
  const direct = vi.fn(async () => ({ ok: true, status: 200, text: async () => 'Product offer' }));
  vi.stubGlobal('fetch', direct);
  expect(await fetchPageForVerification('https://shop.example.de/product', { timeoutMs: 6000 })).toMatchObject({ ok: true, text: 'Product offer', via: 'direct' });
});
