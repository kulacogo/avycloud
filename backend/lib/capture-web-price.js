'use strict';

const { captureOfferQuantityMatches } = require('./capture-offer-quantity');

function isGermanOfferPage(url, html = '') {
  try {
    const parsed = new URL(url);
    // German storefronts commonly live on .com. A EUR amount alone is not
    // evidence of the German consumer market (e.g. Portugal or Slovakia).
    return /\.de$/i.test(parsed.hostname) || /^\/de(?:[-_]de)?(?:\/|$)/i.test(parsed.pathname) ||
      /<html\b[^>]*\blang=["']de(?:-DE)?["']/i.test(html);
  } catch { return false; }
}

function findGermanProductAlternate(html, pageUrl) {
  const { classifyPriceSourceUrl } = require('./price-evidence');
  const base = new URL(pageUrl);
  const merchant = host => host.toLowerCase().replace(/^www\./, '').replace(/\.[^.]+$/, '');
  for (const tag of String(html || '').matchAll(/<link\b[^>]*>/gi)) {
    const attrs = Object.fromEntries([...tag[0].matchAll(/([a-z-]+)\s*=\s*["']([^"']*)["']/gi)].map(match => [match[1].toLowerCase(), match[2]]));
    if (!String(attrs.rel || '').toLowerCase().split(/\s+/).includes('alternate') || !/^de(?:-de)?$/i.test(attrs.hreflang || '')) continue;
    try {
      const target = new URL(String(attrs.href || '').replace(/&amp;/g, '&'), base);
      if (target.href === base.href || classifyPriceSourceUrl(target.href).kind !== 'candidate' || !isGermanOfferPage(target.href)) continue;
      if (target.hostname !== base.hostname && merchant(target.hostname) !== merchant(base.hostname)) continue;
      if (/cart|warenkorb|checkout|wishlist|delete|remove|logout|add[-_]/i.test(target.pathname)) continue;
      return target.href;
    } catch { /* Ignore malformed alternate URLs. */ }
  }
  return null;
}

// Read prices from the matched Product's own Offer, never from shipping fees,
// crossed-out prices, recommendation cards or a search snippet.
function extractProductOffer(html, product, matchesIdentity) {
  const products = [];
  const visit = (node, variant = false) => {
    if (Array.isArray(node)) return node.forEach(item => visit(item, variant));
    if (!node || typeof node !== 'object') return;
    if ([].concat(node['@type'] || []).includes('Product')) products.push({ node, variant: variant || Boolean(node.isVariantOf) });
    if (node['@graph']) visit(node['@graph']);
    if (node.mainEntity) visit(node.mainEntity);
    if (node.hasVariant) visit(node.hasVariant, true);
  };
  for (const match of String(html || '').matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(match[1])); } catch { /* Ignore malformed unrelated markup. */ }
  }
  const amounts = [];
  for (const { node, variant } of products) {
    if (!captureOfferQuantityMatches(product, node.name)) continue;
    const identity = { name: node.name, description: node.description, brand: node.brand, color: node.color, size: node.size, sku: node.sku, mpn: node.mpn, gtin: node.gtin, gtin8: node.gtin8, gtin12: node.gtin12, gtin13: node.gtin13, gtin14: node.gtin14, productID: node.productID };
    if (!matchesIdentity({ product, page: { text: JSON.stringify(identity), identity: variant ? null : identity } })) continue;
    for (const offer of [].concat(node.offers || [])) {
      if (!offer) continue;
      if (/OutOfStock|Discontinued|SoldOut/i.test(offer.availability || '')) continue;
      if (/UsedCondition|RefurbishedCondition/i.test(offer.itemCondition || node.itemCondition || '')) continue;
      const prices = offer.price != null ? [offer] : [].concat(offer.priceSpecification || []);
      for (const price of prices) {
        if (!price || (price.priceCurrency || offer.priceCurrency) !== 'EUR') continue;
        // Ignore reference/unit/member/installment prices and crossed-out MSRP.
        if (price.priceType && !/SalePrice$/.test(price.priceType)) continue;
        if (price.priceComponentType || price.referenceQuantity || price.billingDuration || price.validForMemberTier || price.valueAddedTaxIncluded === false) continue;
        const amount = Number(String(price.price ?? '').replace(',', '.'));
        if (Number.isFinite(amount) && amount >= 1 && amount <= 20000) amounts.push(amount);
      }
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

async function lookupCaptureWebPrice(product, { referencePages = [], deadline, matchesIdentity, fetchPage, diagnostics = {} } = {}) {
  const fetcher = fetchPage || require('./price-evidence').fetchPageForVerification;
  const { indexedOfferPrice } = require('./capture-indexed-offer');
  const { isInfraFetchFailure, classifyPriceSourceUrl } = require('./price-evidence');
  const seen = new Set();
  const indexed = new Map(referencePages.map(row => [row.url, indexedOfferPrice(row, product, matchesIdentity)]));
  const read = async (url, follow = true) => {
    if (Date.now() >= deadline || seen.has(url)) return null;
    seen.add(url);
    diagnostics.pages = (diagnostics.pages || 0) + 1;
    try {
      const page = await fetcher(url, { timeoutMs: Math.max(1, Math.min(4000, deadline - Date.now())) });
      if (Date.now() >= deadline) return null;
      const indexedPrice = indexed.get(url);
      if (!page?.ok) {
        diagnostics.page_failures = diagnostics.page_failures || {};
        const code = String(Number(page?.status) || 0);
        diagnostics.page_failures[code] = (diagnostics.page_failures[code] || 0) + 1;
        if (indexedPrice && isInfraFetchFailure(page?.status)) {
          return { name: `Google-Index: ${new URL(url).hostname}`, url, price: indexedPrice, evidence_type: 'search_index', verified: false, checked_at: new Date().toISOString() };
        }
        return null;
      }
      const resolvedUrl = page.resolvedUrl || url;
      if (classifyPriceSourceUrl(resolvedUrl).kind !== 'candidate') return null;
      if (!isGermanOfferPage(resolvedUrl, page.html)) {
        // Search may find a merchant's foreign storefront for the exact MPN.
        // Follow only its explicit German alternate, with one hop and the
        // same deadline. Never transform or guess the merchant's URL.
        const alternate = follow && findGermanProductAlternate(page.html, resolvedUrl);
        if (!alternate) return null;
        diagnostics.german_alternates = (diagnostics.german_alternates || 0) + 1;
        return read(alternate, false);
      }
      // Do not mistake an explicitly advertised net price for a gross price.
      if (/(?:zzgl\.?|exkl\.?)\s*(?:der\s*)?(?:MwSt|Mehrwertsteuer)/i.test(page.text || '')) return null;
      const amount = extractProductOffer(page.html, product, matchesIdentity);
      if (amount !== null) return { name: new URL(resolvedUrl).hostname, url: resolvedUrl, price: amount, verified: true, verified_at: new Date().toISOString() };
      // Without an attributable Product Offer, a number elsewhere on the
      // page (shipping, crossed-out price, recommendation) is not proof.
      const child = follow && findProductLink(page.html, resolvedUrl, product);
      return child ? read(child, false) : null;
    } catch { return null; }
  };
  const urls = [...new Set(referencePages.map(page => page.url).filter(Boolean))].slice(0, 6);
  const sources = [...new Map((await Promise.all(urls.map(url => read(url)))).filter(Boolean).map(source => [source.url, source])).values()];
  if (!sources.length) return null;
  const directSources = sources.filter(source => source.verified);
  const chosen = directSources.length ? directSources : sources;
  const amounts = chosen.map(source => source.price).sort((a, b) => a - b);
  const mid = Math.floor(amounts.length / 2);
  const amount = amounts.length % 2 ? amounts[mid] : (amounts[mid - 1] + amounts[mid]) / 2;
  return { amount: Math.round(amount * 100) / 100, currency: 'EUR', sources: chosen, confidence: directSources.length ? 0.85 : 0.65, via: directSources.length ? 'web_product_offer' : 'search_index_offer' };
}

module.exports = { extractProductOffer, findProductLink, lookupCaptureWebPrice, isGermanOfferPage, findGermanProductAlternate };
