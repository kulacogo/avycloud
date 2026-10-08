'use strict';
const { capturePageMatchesIdentity } = require('../lib/capture-price');
const { extractProductOffer, findProductLink, lookupCaptureWebPrice } = require('../lib/capture-web-price');
const product = { identification: { brand: 'Steinel', name: 'Steinel L 605 S' }, details: { identifiers: { ean: '4007841065287', mpn: '065287' } } };
const node = { '@type': 'Product', name: 'Steinel L 605 S', gtin13: '4007841065287', offers: [{ '@type': 'Offer', price: '102.32', priceCurrency: 'EUR', shippingDetails: { shippingRate: { value: 0, currency: 'EUR' } } }] };
const html = value => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

it('uses catalog pages only to discover an actual product link, never their displayed prices', async () => {
  const catalog = 'https://shop.de/collections/lighting';
  const child = 'https://shop.de/products/steinel-l-605-s-065287';
  const fetchPage = vi.fn(async url => ({ ok: true, html: url === catalog
    ? `<p>Sale 1 EUR</p><a href="/products/steinel-l-605-s-065287">L605</a>` : html(node) }));
  const result = await lookupCaptureWebPrice(product, { referencePages: [{ url: catalog }], deadline: Date.now() + 1000, matchesIdentity: capturePageMatchesIdentity, fetchPage });
  expect(result).toMatchObject({ amount: 102.32, sources: [{ url: child }] });
});

it('does not treat an Austrian storefront with German text as a German price', async () => {
  const fetchPage = async () => ({ ok: true, html: `<html lang="de">${html(node)}</html>` });
  expect(await lookupCaptureWebPrice(product, { referencePages: [{ url: 'https://shop.at/products/065287' }], deadline: Date.now() + 1000, matchesIdentity: capturePageMatchesIdentity, fetchPage })).toBeNull();
});

it('reads only the matched product offer, not shipping or other products', () => {
  const unrelated = { ...node, gtin13: '9999999999999', name: 'Steinel other model', offers: [{ price: 9.99, priceCurrency: 'EUR' }] };
  expect(extractProductOffer(html({ '@graph': [unrelated, node] }), product, capturePageMatchesIdentity)).toBe(102.32);
});
it.each([{ priceCurrency: 'USD' }, { availability: 'https://schema.org/OutOfStock' }, { itemCondition: 'UsedCondition' }, { price: 0 }])('rejects unsuitable offer %j', change => {
  expect(extractProductOffer(html({ ...node, offers: [{ ...node.offers[0], ...change }] }), product, capturePageMatchesIdentity)).toBeNull();
});
it('follows one actual product link from a catalog, never a cart/action URL', async () => {
  const root = 'https://shop.de/lighting.html';
  const child = 'https://shop.de/STEINEL_065287.html';
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

it('rejects mismatched bundles even when their barcode matches', () => {
  const bundle = { ...product, identification: { ...product.identification, name: 'Steinel L 605 S 4 Stück' } };
  expect(extractProductOffer(html({ ...node, name: 'Steinel L 605 S 8 Stück' }), bundle, capturePageMatchesIdentity)).toBeNull();
  expect(extractProductOffer(html({ ...node, name: 'Steinel L 605 S 4 Stück' }), bundle, capturePageMatchesIdentity)).toBe(102.32);
});

it.each(['https://shop.pt/p/l605', 'https://shop.com/sk/p/l605'])('rejects foreign storefront %s even with a matching EUR offer', async url => {
  expect(await lookupCaptureWebPrice(product, { referencePages: [{ url }], deadline: Date.now() + 1000, matchesIdentity: capturePageMatchesIdentity, fetchPage: async () => ({ ok: true, html: html(node) }) })).toBeNull();
});

it('records the actual redirected merchant URL and deduplicates the offer', async () => {
  const resolvedUrl = 'https://shop.de/p/l605';
  const result = await lookupCaptureWebPrice(product, { referencePages: [{ url: 'https://vertexaisearch.cloud.google.com/redirect/a' }, { url: resolvedUrl }], deadline: Date.now() + 1000, matchesIdentity: capturePageMatchesIdentity, fetchPage: async () => ({ ok: true, resolvedUrl, html: html(node) }) });
  expect(result.sources).toHaveLength(1);
  expect(result.sources[0].url).toBe(resolvedUrl);
});

it('accepts exact structured index offers only for infrastructure failures, not 404 or contradictory live pages', async () => {
  const row = { url: 'https://shop.de/p/l605', title: 'Steinel L 605 S 4007841065287', richSnippet: { bottom: { extensions: ['102,32 €', 'Auf Lager'] } } };
  const lookup = page => lookupCaptureWebPrice(product, { referencePages: [row], deadline: Date.now() + 1000, matchesIdentity: capturePageMatchesIdentity, fetchPage: async () => page });
  expect(await lookup({ ok: false, status: 403 })).toMatchObject({ amount: 102.32, sources: [{ verified: false, evidence_type: 'search_index' }] });
  expect(await lookup({ ok: false, status: 404 })).toBeNull();
  expect(await lookup({ ok: true, html: html({ ...node, offers: { price: 102.32, priceCurrency: 'EUR', availability: 'OutOfStock' } }) })).toBeNull();
  expect(await lookup({ ok: true, text: 'Steinel L 605 S 4007841065287 zzgl. MwSt', html: html(node) })).toBeNull();
  expect(await lookup({ ok: true, text: 'Steinel L 605 S 4007841065287 Versand 102,32 €', html: '' })).toBeNull();
});

it('follows the merchant-declared German product variant when search finds its foreign storefront', async () => {
  const foreign = 'https://shop.nl/products/065287';
  const german = 'https://shop.de/produkte/065287';
  const diagnostics = {};
  const fetchPage = vi.fn(async url => ({ ok: true, html: url === foreign
    ? `<link href="${german}" hreflang="de" rel="alternate">${html({ ...node, offers: { price: 99, priceCurrency: 'EUR' } })}`
    : html(node) }));
  const result = await lookupCaptureWebPrice(product, { referencePages: [{ url: foreign }], deadline: Date.now() + 1000, matchesIdentity: capturePageMatchesIdentity, fetchPage, diagnostics });
  expect(result).toMatchObject({ amount: 102.32, sources: [{ url: german, verified: true }] });
  expect(fetchPage.mock.calls.map(args => args[0])).toEqual([foreign, german]);
  expect(diagnostics.german_alternates).toBe(1);
});

it.each([
  '<link rel="alternate" hreflang="de-AT" href="https://shop.at/p/065287">',
  '<link rel="alternate" hreflang="de" href="https://another-shop.de/p/065287">',
  '<link rel="alternate" hreflang="de" href="https://shop.de/cart/065287">',
])('does not follow a different region, unrelated merchant or action URL: %s', alternate => {
  const { findGermanProductAlternate } = require('../lib/capture-web-price');
  expect(findGermanProductAlternate(alternate, 'https://shop.nl/p/065287')).toBeNull();
});

it('rejects an alternate that contains the wrong product and never follows a second alternate', async () => {
  const foreign = 'https://shop.nl/products/065287';
  const german = 'https://shop.de/produkte/065287';
  const fetchPage = vi.fn(async url => ({ ok: true, html: url === foreign
    ? `<link rel="alternate" hreflang="de-DE" href="${german}">`
    : html({ ...node, gtin13: '9999999999999', name: 'Unrelated product' }) + '<link rel="alternate" hreflang="de" href="https://shop.de/another">' }));
  expect(await lookupCaptureWebPrice(product, { referencePages: [{ url: foreign }], deadline: Date.now() + 1000, matchesIdentity: capturePageMatchesIdentity, fetchPage })).toBeNull();
  expect(fetchPage).toHaveBeenCalledTimes(2);
});
