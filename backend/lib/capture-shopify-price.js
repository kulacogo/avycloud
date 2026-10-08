'use strict';

const { decodeHtmlEntities } = require('./web-search-html');
const { captureOfferQuantityMatches } = require('./capture-offer-quantity');

// Shopify often exposes only the default color in JSON-LD. Its product-option
// JSON contains the exact purchasable variants. Parse data only, never execute
// merchant scripts. A matching brand/name alone cannot identify a variant.
function extractShopifyVariantOffer(html, product) {
  const currency = String(html || '').match(/Shopify\.currency\s*=\s*(\{[^;]+\})\s*;/);
  try { if (JSON.parse(currency?.[1] || '{}').active !== 'EUR') return null; } catch { return null; }
  const ids = product.details?.identifiers || {};
  const barcodes = [ids.ean, ids.gtin, ids.upc].map(value => String(value || '')).filter(value => /^\d{8,14}$/.test(value));
  if (!barcodes.length) return null;
  const variants = [];
  for (const match of String(html).matchAll(/\bdata-option-value\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    try {
      const data = JSON.parse(decodeHtmlEntities(match[2]));
      if (Array.isArray(data)) variants.push(...data);
    } catch { /* Unrelated or invalid data attribute. */ }
  }
  const prices = variants.filter(row => row && barcodes.includes(String(row.barcode)) &&
    row.available === true && row.inventory_management === 'shopify' &&
    row.requires_selling_plan !== true && Number(row.quantity_rule?.min || 1) === 1 &&
    captureOfferQuantityMatches(product, row.name) &&
    Number.isInteger(row.price) && row.price >= 100 && row.price <= 2000000)
    .map(row => row.price / 100);
  return prices.length ? Math.min(...prices) : null;
}

// Documented read-only Ajax API. Its prices are discovery hints only: callers
// still load and verify the actual variant page before accepting an amount.
// https://shopify.dev/docs/api/ajax/reference/predictive-search
async function discoverShopifyProducts({ html, url, product, fetchPage, deadline }) {
  if (!/Shopify\.shop\s*=|Shopify\.currency\s*=/.test(html || '')) return [];
  const origin = new URL(url).origin;
  const rootMatch = String(html).match(/Shopify\.routes\s*=\s*(\{[^;]+\})\s*;/);
  let root = '/';
  try { root = JSON.parse(rootMatch?.[1] || '{}').root || '/'; } catch { /* Default root. */ }
  const ids = product.details?.identifiers || {};
  const queries = [...new Set([ids.ean || ids.gtin, product.details?.attributes?.Modell].filter(Boolean))];
  for (const query of queries.slice(0, 2)) {
    if (deadline - Date.now() < 1000) break;
    const endpoint = new URL(`${root}search/suggest.json`, origin);
    if (endpoint.origin !== origin) return [];
    endpoint.searchParams.set('q', query);
    endpoint.searchParams.set('resources[type]', 'product');
    endpoint.searchParams.set('resources[limit]', '3');
    const response = await fetchPage(endpoint.href, { timeoutMs: Math.min(4000, deadline - Date.now()) });
    if (!response?.ok) continue;
    try {
      const data = JSON.parse(response.html || response.text || '{}');
      const urls = (data.resources?.results?.products || []).map(row => {
        try {
          const link = new URL(row.url, origin);
          return link.origin === origin && /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?products\/[^/]+$/i.test(link.pathname) ? link.href : null;
        } catch { return null; }
      }).filter(Boolean);
      if (urls.length) return urls.slice(0, 3);
    } catch { /* Not a Shopify JSON response. */ }
  }
  return [];
}

module.exports = { extractShopifyVariantOffer, discoverShopifyProducts };
