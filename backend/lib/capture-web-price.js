'use strict';

// Read prices from the matched Product's own Offer, never from shipping fees,
// crossed-out prices, recommendation cards or a search snippet.
function extractProductOffer(html, product, matchesIdentity) {
  const products = [];
  const visit = node => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    if ([].concat(node['@type'] || []).includes('Product')) products.push(node);
    if (node['@graph']) visit(node['@graph']);
  };
  for (const match of String(html || '').matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(match[1])); } catch { /* Ignore malformed unrelated markup. */ }
  }
  const amounts = [];
  for (const node of products) {
    const identity = { name: node.name, brand: node.brand, sku: node.sku, mpn: node.mpn, gtin: node.gtin, gtin8: node.gtin8, gtin12: node.gtin12, gtin13: node.gtin13, gtin14: node.gtin14, productID: node.productID };
    if (!matchesIdentity({ product, page: { text: JSON.stringify(identity) } })) continue;
    for (const offer of [].concat(node.offers || [])) {
      if (!offer || offer.priceCurrency !== 'EUR') continue;
      if (/OutOfStock|Discontinued|SoldOut/i.test(offer.availability || '')) continue;
      if (/UsedCondition|RefurbishedCondition/i.test(offer.itemCondition || node.itemCondition || '')) continue;
      const amount = Number(String(offer.price ?? '').replace(',', '.'));
      if (Number.isFinite(amount) && amount >= 1 && amount <= 20000) amounts.push(amount);
    }
  }
  return amounts.length ? Math.min(...amounts) : null;
}

function findProductLink(html, pageUrl, product) {
  const ids = product.details?.identifiers || {};
  const tokens = [ids.ean, ids.gtin, ids.mpn].map(value => String(value || '').toLowerCase()).filter(value => /^[a-z0-9-]{4,}$/.test(value));
  if (!tokens.length) return null;
  const base = new URL(pageUrl);
  for (const match of String(html || '').matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    try {
      const link = new URL(match[1].replace(/&amp;/g, '&'), base);
      if (link.origin !== base.origin || link.search || link.hash || link.href === base.href) continue;
      if (!/\.html?$|\/(?:product|produkt|p)\//i.test(link.pathname)) continue;
      if (/cart|warenkorb|checkout|wishlist|delete|remove|logout|add[-_]/i.test(link.pathname)) continue;
      if (tokens.some(token => link.pathname.toLowerCase().includes(token))) return link.href;
    } catch { /* Not a navigable product URL. */ }
  }
  return null;
}

async function lookupCaptureWebPrice(product, { referencePages = [], deadline, matchesIdentity, fetchPage } = {}) {
  const fetcher = fetchPage || require('./price-evidence').fetchPageForVerification;
  const seen = new Set();
  const read = async (url, follow = true) => {
    if (Date.now() >= deadline || seen.has(url)) return null;
    seen.add(url);
    try {
      const page = await fetcher(url, { timeoutMs: Math.max(1, Math.min(4000, deadline - Date.now())) });
      if (!page?.ok || Date.now() >= deadline) return null;
      const amount = extractProductOffer(page.html, product, matchesIdentity);
      if (amount !== null) return { name: new URL(url).hostname, url, price: amount, verified: true, verified_at: new Date().toISOString() };
      const child = follow && findProductLink(page.html, url, product);
      return child ? read(child, false) : null;
    } catch { return null; }
  };
  const urls = [...new Set(referencePages.map(page => page.url).filter(Boolean))].slice(0, 3);
  const sources = (await Promise.all(urls.map(url => read(url)))).filter(Boolean);
  if (!sources.length) return null;
  const amounts = sources.map(source => source.price).sort((a, b) => a - b);
  const mid = Math.floor(amounts.length / 2);
  const amount = amounts.length % 2 ? amounts[mid] : (amounts[mid - 1] + amounts[mid]) / 2;
  return { amount: Math.round(amount * 100) / 100, currency: 'EUR', sources, confidence: 0.85, via: 'web_product_offer' };
}

module.exports = { extractProductOffer, findProductLink, lookupCaptureWebPrice };
