'use strict';
const { capturePageMatchesIdentity } = require('../lib/capture-price');
const { verifyPriceSources } = require('../lib/price-evidence');
const product = { identification: { brand: 'Träumeland', name: 'Träumeland Carefor Midi Kissen' }, details: { identifiers: { mpn: 'T040321', ean: '9120064852375' } } };

it('does not accept another model of the same brand with the same price', async () => {
  const page = { ok: true, text: 'Träumeland Carefor Mini T040300 46,99 EUR. '.repeat(20) };
  const result = await verifyPriceSources({ product, sources: [{ url: 'https://shop.example/mini', price: 46.99 }], fetchPage: async () => page, matchPage: capturePageMatchesIdentity });
  expect(result.verified).toEqual([]);
  expect(result.failed[0].reason).toBe('product_identity_not_verified');
});

it.each(['T040321', '9120064852375'])('accepts a real identifier in page content: %s', id => {
  expect(capturePageMatchesIdentity({ product, page: { text: `Träumeland ${id} 46,99 EUR` } })).toBe(true);
});

it('does not match a code merely as a substring of another code', () => {
  expect(capturePageMatchesIdentity({ product, page: { text: 'Träumeland T0403219' } })).toBe(false);
});

it('requires descriptive product overlap when no usable identifier exists', () => {
  const generic = { identification: { brand: 'Markenlos', name: 'PMMA Lichtfaser Sternenhimmel Schwarz' }, details: { identifiers: { mpn: 'Nicht zutreffend' } } };
  expect(capturePageMatchesIdentity({ product: generic, page: { text: 'PMMA Lichtfaser Sternenhimmel Schwarz' } })).toBe(true);
  expect(capturePageMatchesIdentity({ product: generic, page: { text: 'Markenlos LED Lampe Schwarz' } })).toBe(false);
});
