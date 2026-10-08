'use strict';

const browse = vi.fn();
const grounding = vi.fn();
const verify = vi.fn();
const search = vi.fn();
const webPrice = vi.fn();
function stub(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('../lib/price-enrichment', { findEbayBrowsePriceForProductV1: browse });
stub('../lib/gemini-price-lookup', { lookupPricesViaGemini: grounding });
stub('../lib/evidence-provider', { search });
stub('../lib/capture-web-price', { lookupCaptureWebPrice: webPrice });
const evidence = require('../lib/price-evidence');
stub('../lib/price-evidence', { ...evidence, verifyPriceSources: verify });

const { lookupCapturePrice } = require('../lib/capture-price');
const product = () => ({ tenantId: 'default', identification: { name: 'CASO B 300 VacuServe', brand: 'CASO' }, details: { pricing: {} } });
const source = { url: 'https://shop.example/caso-b300', price: 59.99 };

beforeEach(() => {
  vi.useFakeTimers();
  browse.mockReset().mockResolvedValue({ ok: false });
  grounding.mockReset().mockResolvedValue([]);
  search.mockReset().mockResolvedValue({ results: [] });
  webPrice.mockReset().mockResolvedValue(null);
  verify.mockReset().mockImplementation(async ({ sources }) => ({ verified: sources, failed: [] }));
});
afterEach(() => vi.useRealTimers());

it('reuses verified content-research pages before paying for another discovery pass', async () => {
  webPrice.mockResolvedValue({ amount: 19, sources: [source], via: 'web_product_offer' });
  const result = await lookupCapturePrice(product(), { referencePages: [{ url: source.url }] });
  expect(result.amount).toBe(19);
  expect(search).not.toHaveBeenCalled();
  expect(browse).not.toHaveBeenCalled();
  expect(grounding).not.toHaveBeenCalled();
});

it('returns a completed Browse result despite a hanging second source; never mutates the input', async () => {
  browse.mockResolvedValue({ ok: true, amount: 59.99, sources: [source] });
  grounding.mockReturnValue(new Promise(() => {}));
  webPrice.mockReturnValue(new Promise(() => {}));
  const p = product();
  const promise = lookupCapturePrice(p, { budgetMs: 1000 });
  await vi.advanceTimersByTimeAsync(1001);
  expect(await promise).toMatchObject({ amount: 59.99, via: 'ebay_browse' });
  expect(p.details.pricing).toEqual({});
  expect(browse).toHaveBeenCalledTimes(1);
  expect(grounding).not.toHaveBeenCalled();
});

it('uses grounding only to discover URLs and returns the independently read offer price', async () => {
  grounding.mockResolvedValue([49.99, 59.99, 69.99].map(amount => ({ amount, currency: 'EUR', url: source.url, title: 'CASO B 300' })));
  webPrice.mockImplementation(async (_product, { referencePages }) => referencePages.length
    ? { amount: 64.99, currency: 'EUR', confidence: 0.85, sources: [{ ...source, price: 64.99 }] } : null);
  const price = await lookupCapturePrice(product());
  expect(price).toMatchObject({ amount: 64.99, via: 'gemini_grounding', confidence: 0.85 });
  expect(verify).not.toHaveBeenCalled();
  expect(price.sources).toHaveLength(1);
});

it('does not turn blocked pages, wrong products or missing offers into an invented price', async () => {
  grounding.mockResolvedValue([{ amount: 99, currency: 'EUR', url: source.url }]);
  verify.mockResolvedValue({ verified: [], failed: [{ reason: 'page_not_about_product' }] });
  expect(await lookupCapturePrice(product())).toBeNull();
});

it('rejects foreign currency and search/image URLs before any page fetch', async () => {
  grounding.mockResolvedValue([
    { amount: 10, currency: 'USD', url: source.url },
    { amount: 10, currency: 'EUR', url: 'https://www.ebay.de/sch/i.html?_nkw=caso' },
    { amount: 10, currency: 'EUR', url: 'https://shop.example/image.jpg' },
  ]);
  expect(await lookupCapturePrice(product())).toBeNull();
  expect(verify).not.toHaveBeenCalled();
});

it('finishes on the shared deadline and ignores late results', async () => {
  let release;
  browse.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const pending = lookupCapturePrice(product(), { budgetMs: 1000 });
  await vi.advanceTimersByTimeAsync(1001);
  expect(await pending).toBeNull();
  release({ ok: true, amount: 200, sources: [source] });
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it('isolates source errors', async () => {
  browse.mockRejectedValue(new Error('quota'));
  grounding.mockRejectedValue(new Error('unavailable'));
  expect(await lookupCapturePrice(product())).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it('passes actual result URLs to the one grounding call', async () => {
  search.mockResolvedValue({ results: [{ title: 'CASO B 300', url: source.url }] });
  await lookupCapturePrice(product());
  expect(grounding.mock.calls[0][1].referencePages).toEqual([{ title: 'CASO B 300', url: source.url }]);
  expect(search).toHaveBeenCalledTimes(1);
  expect(grounding).toHaveBeenCalledTimes(1);
});

it('avoids any paid grounding call when a direct web offer is available', async () => {
  webPrice.mockResolvedValue({ amount: 102.32, currency: 'EUR', confidence: 0.85, sources: [source], via: 'web_product_offer' });
  expect(await lookupCapturePrice(product())).toMatchObject({ amount: 102.32, via: 'web_product_offer' });
  expect(grounding).not.toHaveBeenCalled();
});
