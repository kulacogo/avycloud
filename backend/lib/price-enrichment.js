'use strict';

/**
 * Price enrichment helpers extracted from index.js.
 *
 * Provides multi-source price lookup for products:
 *   1. SerpAPI (via ensurePriceCoverage)
 *   2. eBay Browse API (via ebay-browse-title-insights)
 *   3. BrightData-backed web search + HTML scraping
 *
 * Used by:
 *   - POST /api/v2/identify  (identify pipeline)
 *   - POST /api/price-refresh (manual price refresh)
 */

const { fetchWithUnlocker } = require('./web-unlocker');
const { search: searchEvidence, searchSite: searchEvidenceSite } = require('./evidence-provider');
const { ensurePriceCoverage } = require('../services/enrichment');

// --- Constants ---
const PRICE_REFRESH_TIMEOUT_MS = parseInt(process.env.PRICE_REFRESH_TIMEOUT_MS || '20000', 10);
const PRICE_MARKETPLACE_SITES = ['ebay.de', 'kaufland.de', 'hood.de'];
const PRICE_USED_HINT = /\b(gebraucht|used|refurb|refurbished|renewed|b-ware|pre-owned|second hand|open box)\b/i;

// --- Pure helpers ---

function priceSafeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function medianNumber(values = []) {
  const nums = values
    .filter((n) => typeof n === 'number' && Number.isFinite(n))
    .sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function parseEurAmount(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const cleaned = s
    .replace(/\s+/g, '')
    .replace(/€/g, '')
    .replace(/EUR/gi, '')
    .replace(/\.(?=\d{3}(\D|$))/g, '') // 1.234,56 -> 1234,56
    .replace(',', '.');
  const v = parseFloat(cleaned);
  if (!Number.isFinite(v)) return null;
  if (v < 0.5 || v > 50000) return null;
  return v;
}

function extractJsonLdBlocks(html = '') {
  const blocks = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html)))) {
    const txt = (m[1] || '').trim();
    if (txt) blocks.push(txt);
    if (blocks.length >= 8) break;
  }
  return blocks;
}

function tryParseJsonLenient(text) {
  const raw = (text == null ? '' : String(text)).trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

function collectPricesFromJsonLd(obj) {
  const out = [];
  const visit = (node) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node !== 'object') return;
    const offers = node.offers;
    if (offers) visit(offers);
    const price = node.price;
    const currency = node.priceCurrency || node.pricecurrency;
    if (price != null) {
      const amount = parseEurAmount(price);
      const cur = priceSafeString(currency).toUpperCase();
      if (amount != null && (!cur || cur === 'EUR')) {
        out.push(amount);
      }
    }
    if (node['@graph']) visit(node['@graph']);
    for (const v of Object.values(node)) {
      visit(v);
    }
  };
  visit(obj);
  return out;
}

function extractPriceCandidates(html) {
  const candidates = [];
  const body = String(html || '');

  const metaAmount =
    body.match(/property=["']?product:price:amount["']?[^>]*content=["']?([\d.,]+)/i)?.[1] ||
    body.match(/itemprop=["']?price["']?[^>]*content=["']?([\d.,]+)/i)?.[1] ||
    body.match(/itemprop=["']?price["']?[^>]*content=["']?(\d+(?:[.,]\d{2})?)/i)?.[1];
  const metaCurrency =
    body.match(/property=["']?product:price:currency["']?[^>]*content=["']?([A-Z]{3})/i)?.[1] ||
    body.match(/itemprop=["']?priceCurrency["']?[^>]*content=["']?([A-Z]{3})/i)?.[1];
  if (metaAmount) {
    const amount = parseEurAmount(metaAmount);
    const cur = priceSafeString(metaCurrency).toUpperCase();
    if (amount != null && (!cur || cur === 'EUR')) {
      candidates.push(amount);
    }
  }

  for (const block of extractJsonLdBlocks(body)) {
    const parsed = tryParseJsonLenient(block);
    if (!parsed) continue;
    const prices = collectPricesFromJsonLd(parsed);
    prices.forEach((p) => candidates.push(p));
  }

  const re = /(?:EUR\s*)?(\d{1,5}(?:[.,]\d{2}))\s*€/gi;
  let m;
  while ((m = re.exec(body))) {
    const amount = parseEurAmount(m[1]);
    if (amount != null) candidates.push(amount);
    if (candidates.length >= 20) break;
  }
  const re2 = /EUR\s*(\d{1,5}(?:[.,]\d{2}))/gi;
  while ((m = re2.exec(body))) {
    const amount = parseEurAmount(m[1]);
    if (amount != null) candidates.push(amount);
    if (candidates.length >= 20) break;
  }

  return Array.from(new Set(candidates)).sort((a, b) => a - b);
}

async function fetchHtmlForPrice(url) {
  const result = await fetchWithUnlocker({
    url,
    method: 'GET',
    format: 'raw',
    timeoutMs: PRICE_REFRESH_TIMEOUT_MS,
    headers: {
      'User-Agent': 'avystock-price-refresh/3.0',
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7',
    },
  });
  if (!result?.success) {
    throw new Error(result?.error || result?.statusText || 'Web Unlocker request failed');
  }
  return String(result.body || '');
}

function hasValidPriceEvidence(lowestPrice) {
  const amount = lowestPrice?.amount;
  const sources = Array.isArray(lowestPrice?.sources) ? lowestPrice.sources : [];
  const hasEvidence = sources.some((s) => s && typeof s.url === 'string' && s.url.trim());
  return typeof amount === 'number' && Number.isFinite(amount) && amount >= 1 && hasEvidence;
}

function normalizeDigitsOnly(value) {
  return String(value == null ? '' : value).replace(/[^\d]/g, '');
}

function pickBestGtinForBrowse(product) {
  const ids = product?.details?.identifiers || {};
  const candidates = []
    .concat(Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [])
    .concat([ids?.ean, ids?.gtin, ids?.upc, product?.identification?.ean, product?.identification?.gtin])
    .filter(Boolean)
    .map((x) => normalizeDigitsOnly(x))
    .filter((x) => x && /^\d+$/.test(x) && [8, 12, 13, 14].includes(x.length));
  return candidates[0] || '';
}

function pickProductTypeForBrowseQuery(product) {
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  return (
    priceSafeString(attrs?.Produktart) ||
    priceSafeString(attrs?.Produkttyp) ||
    priceSafeString(attrs?.Artikeltyp) ||
    ''
  );
}

function buildBrowseQueryForProduct(product) {
  const brand = priceSafeString(product?.identification?.brand);
  const title = priceSafeString(product?.identification?.name);
  const mpn =
    priceSafeString(product?.details?.identifiers?.mpn) ||
    priceSafeString(product?.details?.attributes?.Herstellernummer) ||
    priceSafeString(product?.details?.attributes?.MPN) ||
    priceSafeString(product?.details?.attributes?.mpn);
  const type = pickProductTypeForBrowseQuery(product);
  const parts = [];
  if (brand) parts.push(brand);
  if (type) parts.push(type);
  if (mpn) parts.push(mpn);
  const q = priceSafeString(parts.join(' ')) || title || brand || mpn || '';
  return priceSafeString(q).slice(0, 100);
}

async function findEbayBrowsePriceForProductV1(product) {
  const gtin = pickBestGtinForBrowse(product);
  const query = gtin ? '' : buildBrowseQueryForProduct(product);
  const categoryId = priceSafeString(product?.details?.categoryId || '').replace(/\D+/g, '');
  if (!gtin && !query) {
    return { ok: false, reason: 'no_query', amount: null, sources: [] };
  }

  try {
    const { fetchBrowsePriceSamples } = require('./ebay-browse-title-insights');
    const res = await fetchBrowsePriceSamples({
      categoryId: categoryId || undefined,
      gtin: gtin || undefined,
      query: query || undefined,
      limit: 60,
    });
    const samples = Array.isArray(res?.samples) ? res.samples : [];
    const eur = samples
      .filter((s) => (s?.currency ? String(s.currency).toUpperCase() === 'EUR' : true))
      .filter((s) => typeof s?.value === 'number' && Number.isFinite(s.value) && s.value >= 1)
      .filter((s) => priceSafeString(s?.url).startsWith('http'));

    if (eur.length < 3) {
      return {
        ok: false,
        reason: 'too_few_samples',
        amount: null,
        sources: [],
        meta: { sampleCount: eur.length, total: Number(res?.total || 0) },
      };
    }

    const median = medianNumber(eur.map((s) => s.value));
    if (median == null) {
      return { ok: false, reason: 'no_median', amount: null, sources: [] };
    }

    const timestamp = new Date().toISOString();
    const sorted = eur
      .slice()
      .sort(
        (a, b) =>
          Math.abs(a.value - median) - Math.abs(b.value - median) || a.value - b.value
      );
    const sources = sorted.slice(0, 6).map((s) => ({
      name: 'ebay.de',
      url: s.url,
      price: s.value,
      checked_at: timestamp,
    }));
    return {
      ok: true,
      amount: median,
      currency: 'EUR',
      sources,
      meta: {
        via: gtin ? 'gtin' : 'q',
        query: gtin ? gtin : query,
        categoryId: categoryId || null,
        total: Number(res?.total || 0),
      },
    };
  } catch (e) {
    return { ok: false, reason: 'browse_error', amount: null, sources: [], error: e?.message || String(e) };
  }
}

async function findWebPriceForProductV1(product) {
  const brand = priceSafeString(product?.identification?.brand);
  const title = priceSafeString(product?.identification?.name);
  const mpn =
    priceSafeString(product?.details?.identifiers?.mpn) ||
    priceSafeString(product?.details?.attributes?.Herstellernummer) ||
    priceSafeString(product?.details?.attributes?.MPN) ||
    priceSafeString(product?.details?.attributes?.mpn);
  const barcode =
    (Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [])
      .map((x) => priceSafeString(x))
      .find((x) => x.length >= 8) ||
    priceSafeString(product?.details?.identifiers?.ean) ||
    priceSafeString(product?.details?.identifiers?.gtin) ||
    priceSafeString(product?.details?.identifiers?.upc) ||
    '';
  const sku =
    priceSafeString(product?.identification?.sku) ||
    priceSafeString(product?.details?.identifiers?.sku) ||
    priceSafeString(product?.id);

  const negativeTerms = '-gebraucht -used -refurb -refurbished -renewed -b-ware -openbox';
  const queries = [];
  if (barcode) queries.push(`${barcode} neu preis ${negativeTerms}`);
  if (brand && mpn) queries.push(`${brand} ${mpn} neu preis ${negativeTerms}`);
  if (brand && title) queries.push(`${brand} ${title} neu preis ${negativeTerms}`);
  if (title) queries.push(`${title} neu preis ${negativeTerms}`);
  if (sku && sku !== title) queries.push(`${sku} neu preis ${negativeTerms}`);

  const tried = [];
  let results = [];
  let usedQuery = '';
  let usedEngine = null;

  for (const q of queries.slice(0, 3)) {
    for (const site of PRICE_MARKETPLACE_SITES) {
      const res = await searchEvidenceSite(q, site, { limit: 4, locale: 'de-DE' });
      tried.push({ q, site, ok: res.ok, engine: res.engine || null, error: res.error || null });
      if (res.ok && Array.isArray(res.results) && res.results.length) {
        results = res.results;
        usedQuery = `${q} site:${site}`;
        usedEngine = res.engine;
        break;
      }
    }
    if (results.length) break;
  }

  if (!results.length) {
    for (const q of queries.slice(0, 3)) {
      const res = await searchEvidence(q, { limit: 6, locale: 'de-DE' });
      tried.push({ q, site: null, ok: res.ok, engine: res.engine || null, error: res.error || null });
      if (res.ok && Array.isArray(res.results) && res.results.length) {
        results = res.results;
        usedQuery = q;
        usedEngine = res.engine;
        break;
      }
    }
  }

  const urls = (results || [])
    .map((r) => priceSafeString(r?.url))
    .filter((u) => u.startsWith('http'))
    .slice(0, 3);

  const sourceCandidates = [];
  for (const url of urls) {
    try {
      const html = await fetchHtmlForPrice(url);
      const pageTitle = html.match(/<title[^>]*>([^<]{3,200})<\/title>/i)?.[1] || '';
      const textBlob = `${pageTitle} ${html.slice(0, 4000)}`;
      if (PRICE_USED_HINT.test(textBlob)) continue;
      const prices = extractPriceCandidates(html);
      if (prices.length) sourceCandidates.push({ url, prices });
    } catch {
      // ignore fetch failures
    }
  }

  if (!sourceCandidates.length) {
    return { ok: false, reason: 'no_price_found', usedQuery, usedEngine, tried, sources: [], amount: null };
  }

  const perSource = sourceCandidates
    .map((c) => {
      const representative = medianNumber(c.prices) ?? c.prices[0] ?? null;
      return { url: c.url, amount: representative };
    })
    .filter((x) => typeof x.amount === 'number' && Number.isFinite(x.amount));

  if (!perSource.length) {
    return { ok: false, reason: 'no_price_found', usedQuery, usedEngine, tried, sources: [], amount: null };
  }

  const target = medianNumber(perSource.map((x) => x.amount));
  const best =
    typeof target === 'number' && Number.isFinite(target)
      ? perSource
          .slice()
          .sort((a, b) => Math.abs(a.amount - target) - Math.abs(b.amount - target) || a.amount - b.amount)[0]
      : perSource.slice().sort((a, b) => a.amount - b.amount)[0];

  const timestamp = new Date().toISOString();
  const sources = perSource.slice(0, 5).map((c) => ({
    name: (() => {
      try {
        return new URL(c.url).host;
      } catch {
        return 'web';
      }
    })(),
    url: c.url,
    price: c.amount,
    checked_at: timestamp,
  }));

  return {
    ok: true,
    amount: best.amount,
    currency: 'EUR',
    sources,
    usedQuery,
    usedEngine,
    tried,
  };
}

async function enrichPriceForProductBestEffort(product, { force = false, reason = 'price-refresh' } = {}) {
  if (!product) return { ok: false, updated: false, error: 'product_missing' };
  product.details = product.details || {};
  product.details.pricing = product.details.pricing || {};

  const existing = product.details?.pricing?.lowest_price;
  if (!force && hasValidPriceEvidence(existing)) {
    return {
      ok: true,
      updated: false,
      data: {
        lowest_price: existing,
        price_confidence: product.details?.pricing?.price_confidence || 0.8,
      },
      serpTrace: [],
    };
  }

  const serpTrace = [];
  try {
    await ensurePriceCoverage([product], serpTrace, { force });
  } catch (e) {
    // best-effort: SerpAPI may be disabled
  }

  const afterSerp = product.details?.pricing?.lowest_price;
  if (hasValidPriceEvidence(afterSerp)) {
    product.ops = product.ops || {};
    product.ops.data_quality = product.ops.data_quality || {};
    product.ops.data_quality.price_enrich_v1 = {
      at_iso: new Date().toISOString(),
      via: 'serpapi',
      reason,
      sources: (afterSerp.sources || []).map((s) => s?.url).filter(Boolean).slice(0, 5),
    };
    return {
      ok: true,
      updated: true,
      data: {
        lowest_price: afterSerp,
        price_confidence: product.details?.pricing?.price_confidence || 0.8,
      },
      serpTrace,
    };
  }

  const browse = await findEbayBrowsePriceForProductV1(product);
  if (browse.ok && browse.amount && Array.isArray(browse.sources) && browse.sources.length) {
    const timestamp = new Date().toISOString();
    const data = {
      lowest_price: {
        amount: browse.amount,
        currency: 'EUR',
        sources: browse.sources,
        last_checked_iso: timestamp,
      },
      price_confidence: 0.7,
    };
    product.details.pricing.lowest_price = data.lowest_price;
    product.details.pricing.price_confidence = data.price_confidence;
    product.ops = product.ops || {};
    product.ops.data_quality = product.ops.data_quality || {};
    product.ops.data_quality.price_enrich_v1 = {
      at_iso: timestamp,
      via: 'ebay_browse',
      reason,
      query: browse?.meta?.query || null,
      categoryId: browse?.meta?.categoryId || null,
      sources: (browse.sources || []).map((s) => s?.url).filter(Boolean).slice(0, 6),
    };
    return { ok: true, updated: true, data, serpTrace };
  }

  const web = await findWebPriceForProductV1(product);
  if (!web.ok || !web.amount || !Array.isArray(web.sources) || !web.sources.length) {
    product.notes = product.notes || {};
    product.notes.warnings = Array.from(
      new Set([...(product.notes.warnings || []), 'Preis konnte nicht zuverlässig ermittelt werden – bitte prüfen.'])
    );
    return { ok: false, updated: false, error: web.reason || 'no_price_found', serpTrace };
  }

  const timestamp = new Date().toISOString();
  const data = {
    lowest_price: {
      amount: web.amount,
      currency: 'EUR',
      sources: web.sources,
      last_checked_iso: timestamp,
    },
    price_confidence: 0.75,
  };

  product.details.pricing.lowest_price = data.lowest_price;
  product.details.pricing.price_confidence = data.price_confidence;
  product.ops = product.ops || {};
  product.ops.data_quality = product.ops.data_quality || {};
  product.ops.data_quality.price_enrich_v1 = {
    at_iso: timestamp,
    via: 'web',
    reason,
    query: web.usedQuery || null,
    engine: web.usedEngine || null,
    sources: (web.sources || []).map((s) => s?.url).filter(Boolean).slice(0, 5),
  };

  return { ok: true, updated: true, data, serpTrace };
}

module.exports = { enrichPriceForProductBestEffort };
