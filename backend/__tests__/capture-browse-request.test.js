'use strict';
for (const [path, exports] of [
  ['../lib/secret-values', { getSecretValue: async () => 'fixture' }],
  ['../lib/ebay-rate-limiter', { acquireSlot: async () => {} }],
]) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
const { fetchBrowsePriceSamples } = require('../lib/ebay-browse-title-insights');
afterEach(() => vi.unstubAllGlobals());
it('limits capture requests to new fixed-price offers and preserves the API condition metadata', async () => {
  const fetchMock = vi.fn(async url => ({ ok: true, text: async () => JSON.stringify(String(url).includes('/oauth2/')
    ? { access_token: 'fixture', expires_in: 3600 }
    : { total: 1, itemSummaries: [{ itemId: '1', itemWebUrl: 'https://www.ebay.de/itm/1', title: 'Exact item', price: { value: '19.99', currency: 'EUR' }, conditionId: '1000', buyingOptions: ['FIXED_PRICE'] }] }) }));
  vi.stubGlobal('fetch', fetchMock);
  const result = await fetchBrowsePriceSamples({ gtin:'4012345678901', newFixedPriceOnly:true });
  const url = new URL(fetchMock.mock.calls.at(-1)[0]);
  expect(url.searchParams.get('gtin')).toBe('4012345678901');
  expect(url.searchParams.get('filter')).toBe('conditionIds:{1000},buyingOptions:{FIXED_PRICE}');
  expect(result.samples[0]).toMatchObject({ value:19.99, conditionId:'1000', buyingOptions:['FIXED_PRICE'] });
  const normal = await fetchBrowsePriceSamples({ query:'item' });
  expect(new URL(fetchMock.mock.calls.at(-1)[0]).searchParams.has('filter')).toBe(false);
  expect(normal.samples[0]).not.toHaveProperty('conditionId');
});
