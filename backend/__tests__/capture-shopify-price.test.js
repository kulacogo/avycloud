'use strict';
const { extractShopifyVariantOffer } = require('../lib/capture-shopify-price');
const product = { identification: { brand: 'Hobbii', name: 'Hobbii Mega Ball 400 g Orange' }, details: { identifiers: { ean: '5714421128544', mpn: '900194439' } } };
const variant = { id: 123, barcode: '5714421128544', sku: '900194439', name: 'Mega Ball 400 g - Mandarin (39)', price: 1900, available: true, inventory_management: 'shopify', quantity_rule: { min: 1 }, requires_selling_plan: false };
const html = (variants, currency = 'EUR') => `<script>Shopify.currency = ${JSON.stringify({ active: currency })};</script><div data-option-value="${JSON.stringify(variants).replaceAll('"', '&quot;')}"></div>`;

it('distinguishes a concrete product inside a collection from the collection itself', () => {
  const { classifyPriceSourceUrl } = require('../lib/price-evidence');
  expect(classifyPriceSourceUrl('https://shop.de/collections/yarn/products/mega-ball').kind).toBe('candidate');
  expect(classifyPriceSourceUrl('https://shop.de/collections/yarn').kind).toBe('search');
});

it('reads the exact barcode variant price in cents, not the default color or quantity discount', () => {
  const page = html([{ ...variant, barcode: '5714421128117', sku: '900194401', price: 800 }, variant]);
  expect(extractShopifyVariantOffer(page, product)).toBe(19);
});
it.each([
  { available: false }, { barcode: '9999999999999' }, { quantity_rule: { min: 4 } },
  { requires_selling_plan: true }, { price: null }, { price: '1900' },
])('rejects a wrong, unavailable or conditional offer %j', change => {
  expect(extractShopifyVariantOffer(html([{ ...variant, ...change }]), product)).toBeNull();
});
it('requires explicit EUR currency and an exact barcode, never just the shop or similar product name', () => {
  expect(extractShopifyVariantOffer(html([variant], 'USD'), product)).toBeNull();
  expect(extractShopifyVariantOffer(html([variant]), { ...product, details: { identifiers: {} } })).toBeNull();
});
it('never applies a single-unit variant price to a multipack', () => {
  expect(extractShopifyVariantOffer(html([variant]), { ...product, identification: { name: 'Hobbii Mega Ball 4 Stück' } })).toBeNull();
});

it('discovers moved merchant product URLs without using search-result prices or foreign links', async () => {
  const { discoverShopifyProducts } = require('../lib/capture-shopify-price');
  const fetchPage = vi.fn(async () => ({ ok: true, html: JSON.stringify({ resources: { results: { products: [
    { url: '/products/current-product?variant=123', price: '0.01' },
    { url: 'https://another.example/products/x' }, { url: '/cart/add?variant=123' },
  ] } } }) }));
  expect(await discoverShopifyProducts({ html: 'Shopify.shop = "shop";', url: 'https://shop.de/products/old', product, fetchPage, deadline: Date.now() + 5000 }))
    .toEqual(['https://shop.de/products/current-product?variant=123']);
  const requested = new URL(fetchPage.mock.calls[0][0]);
  expect(requested.searchParams.get('q')).toBe('5714421128544');
  expect(requested.pathname).toBe('/search/suggest.json');
});
