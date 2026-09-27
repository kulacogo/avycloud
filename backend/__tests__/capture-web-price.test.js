'use strict';
const { capturePageMatchesIdentity } = require('../lib/capture-price');
const { extractProductOffer, findProductLink, lookupCaptureWebPrice } = require('../lib/capture-web-price');
const product = { identification: { brand: 'Steinel', name: 'Steinel L 605 S' }, details: { identifiers: { ean: '4007841065287', mpn: '065287' } } };
const node = { '@type': 'Product', name: 'Steinel L 605 S', gtin13: '4007841065287', offers: [{ '@type': 'Offer', price: '102.32', priceCurrency: 'EUR', shippingDetails: { shippingRate: { value: 0, currency: 'EUR' } } }] };
const html = value => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

it('reads only the matched product offer, not shipping or other products', () => {
  const unrelated = { ...node, gtin13: '9999999999999', name: 'Steinel other model', offers: [{ price: 9.99, priceCurrency: 'EUR' }] };
  expect(extractProductOffer(html({ '@graph': [unrelated, node] }), product, capturePageMatchesIdentity)).toBe(102.32);
});
it.each([{ priceCurrency: 'USD' }, { availability: 'https://schema.org/OutOfStock' }, { itemCondition: 'UsedCondition' }, { price: 0 }])('rejects unsuitable offer %j', change => {
  expect(extractProductOffer(html({ ...node, offers: [{ ...node.offers[0], ...change }] }), product, capturePageMatchesIdentity)).toBeNull();
});
it('follows one actual product link from a catalog, never a cart/action URL', async () => {
  const root = 'https://shop.example/lighting.html';
  const child = 'https://shop.example/STEINEL_065287.html';
  const catalog = '<a href="cart_065287.html">Cart</a><a href="s01.php?bnr=065287&wk=4">Add</a><a href="STEINEL_065287.html">L605</a>';
  const fetchPage = vi.fn(async url => ({ ok: true, html: url === root ? catalog : html(node) }));
  const result = await lookupCaptureWebPrice(product, { referencePages: [{ url: root }], deadline: Date.now() + 1000, matchesIdentity: capturePageMatchesIdentity, fetchPage });
  expect(result).toMatchObject({ amount: 102.32, sources: [{ url: child }] });
  expect(fetchPage.mock.calls.map(args => args[0])).toEqual([root, child]);
});
it('does not follow cross-origin links or issue requests after the deadline', async () => {
  expect(findProductLink('<a href="https://evil.example/065287.html">item</a>', 'https://shop.example/catalog.html', product)).toBeNull();
  const fetchPage = vi.fn();
  expect(await lookupCaptureWebPrice(product, { referencePages: [{ url: 'https://shop.example/item.html' }], deadline: Date.now() - 1, matchesIdentity: capturePageMatchesIdentity, fetchPage })).toBeNull();
  expect(fetchPage).not.toHaveBeenCalled();
});
