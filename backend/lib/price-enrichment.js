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
// Kein Zyklus: price-evidence.js hat keine Top-Level-Requires (web-search-html nur lazy).
const { classifyPriceSourceUrl } = require('./price-evidence');

// --- Constants ---
const PRICE_REFRESH_TIMEOUT_MS = parseInt(process.env.PRICE_REFRESH_TIMEOUT_MS || '20000', 10);
const PRICE_MARKETPLACE_SITES = ['ebay.de', 'kaufland.de', 'hood.de', 'amazon.de', 'idealo.de', 'zalando.de'];
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
  // INCIDENT 2026-07-11: Vorher zählte JEDER nicht-leere url-String als Beleg —
  // eine einmal gespeicherte Müll-Quelle (Such-URL, gstatic-Thumbnail, "ui")
  // blockierte damit über das Skip-Gate jede künftige Re-Recherche. Beleg zählt
  // nur noch, wenn mindestens eine Quelle eine strukturell taugliche
  // Angebots-URL trägt (classifyPriceSourceUrl kind === 'candidate').
  const hasEvidence = sources.some(
    (s) => s && typeof s.url === 'string' && classifyPriceSourceUrl(s.url).kind === 'candidate'
  );
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

/**
 * Normalize free text for best-effort title matching (German diacritics folded,
 * separators collapsed). Mirrors the spirit of services/enrichment.js
 * normalizeMatchText without importing it (keep price-enrichment self-contained).
 */
function normalizeForMatch(raw) {
  return String(raw == null ? '' : raw)
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[‐-―-]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a conservative match descriptor for a product so we can verify that a
 * given eBay-Browse sample title actually refers to the same product.
 *
 * Returns:
 *   { brand, mpn, keywords[] }  — all lowercased / normalized tokens.
 *
 * Keywords are derived from the product title (>=4 chars, stopwords removed),
 * loosely mirroring services/enrichment.js collectProductKeywords but kept local
 * and purely in-memory (no network).
 */
function buildBrowseMatchDescriptor(product) {
  const brand = normalizeForMatch(
    priceSafeString(product?.identification?.brand)
  );
  const mpnRaw =
    priceSafeString(product?.details?.identifiers?.mpn) ||
    priceSafeString(product?.details?.attributes?.Herstellernummer) ||
    priceSafeString(product?.details?.attributes?.MPN) ||
    priceSafeString(product?.details?.attributes?.mpn);
  const mpn = normalizeForMatch(mpnRaw);

  const STOP = new Set([
    'und', 'oder', 'mit', 'fur', 'fuer', 'der', 'die', 'das', 'ein', 'eine',
    'einer', 'eines', 'zum', 'zur', 'set', 'kit', 'neu', 'new', 'ovp',
  ]);
  const title = normalizeForMatch(priceSafeString(product?.identification?.name));
  const keywords = Array.from(
    new Set(
      title
        .split(/\s+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 4 && !STOP.has(t))
    )
  ).slice(0, 12);

  return { brand, mpn, keywords };
}

/**
 * BUG-089 / BUG-093: best-effort, purely in-memory check that an eBay-Browse
 * sample title actually refers to the product. Used ONLY on the loose
 * keyword-query path (no GTIN constraint). When a strong GTIN/EAN match is
 * available, eBay already constrained the result set and this gate is skipped.
 *
 * A sample passes when its title contains the brand AND
 * (the MPN OR at least 2 product keywords).
 *
 * No HTTP/HEAD validation — matching is title-only to avoid worsening the
 * already-slow improve pipeline (BUG-086).
 */
function browseSampleMatchesProduct(sampleTitle, descriptor) {
  if (!descriptor) return false;
  const { brand, mpn, keywords } = descriptor;
  const title = normalizeForMatch(sampleTitle);
  if (!title) return false;

  // Brand is required. If we don't even know the brand, we cannot safely gate —
  // require an MPN match instead (otherwise reject as un-verifiable).
  if (brand) {
    if (!title.includes(brand)) return false;
  } else if (!mpn || !title.includes(mpn)) {
    return false;
  }

  // Secondary signal: MPN present, OR >= 2 distinct product keywords present.
  if (mpn && title.includes(mpn)) return true;
  const kwHits = (keywords || []).filter((k) => k && title.includes(k)).length;
  return kwHits >= 2;
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
    let eur = samples
      .filter((s) => (s?.currency ? String(s.currency).toUpperCase() === 'EUR' : true))
      .filter((s) => typeof s?.value === 'number' && Number.isFinite(s.value) && s.value >= 1)
      .filter((s) => priceSafeString(s?.url).startsWith('http'));

    // BUG-089 / BUG-093: when NO GTIN constraint was used, eBay returned a loose
    // keyword-query result set that may contain different products. Gate each
    // sample by its title (brand AND (MPN OR >=2 keywords)) before it can count
    // toward the median or be stored as evidence. With a GTIN, eBay already
    // constrained the set to the product — skip the gate to preserve behavior.
    let matchGated = false;
    if (!gtin) {
      const descriptor = buildBrowseMatchDescriptor(product);
      // Only gate if we actually have a usable signal (brand or MPN). If neither
      // is known we cannot verify — leave samples untouched (legacy behavior) but
      // this is rare because buildBrowseQueryForProduct needs brand/type/mpn.
      if (descriptor.brand || descriptor.mpn) {
        eur = eur.filter((s) => browseSampleMatchesProduct(s?.title, descriptor));
        matchGated = true;
      }
    }

    if (eur.length < 3) {
      return {
        ok: false,
        reason: matchGated ? 'too_few_matching_samples' : 'too_few_samples',
        amount: null,
        sources: [],
        meta: { sampleCount: eur.length, total: Number(res?.total || 0), matchGated },
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
        matchGated,
        matchedCount: eur.length,
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

  // BUG-089: Product matching — verify the page actually refers to the same product
  // before extracting prices. Without this, generic queries return unrelated product prices.
  const matchTokens = [brand, mpn, barcode]
    .map((t) => priceSafeString(t).toLowerCase())
    .filter((t) => t.length >= 3);

  const sourceCandidates = [];
  for (const url of urls) {
    try {
      const html = await fetchHtmlForPrice(url);
      const pageTitle = html.match(/<title[^>]*>([^<]{3,200})<\/title>/i)?.[1] || '';
      const textBlob = `${pageTitle} ${html.slice(0, 4000)}`;
      if (PRICE_USED_HINT.test(textBlob)) continue;

      // Product match: at least one identifying token (brand, MPN, or barcode) must appear on the page
      const textLower = textBlob.toLowerCase();
      const hasMatch = matchTokens.length === 0 || matchTokens.some((token) => textLower.includes(token));
      if (!hasMatch) {
        continue; // Page is about a different product — skip
      }

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

async function enrichPriceForProductBestEffort(product, { force = false, reason = 'price-refresh', _fromEnsurePriceCoverage = false } = {}) {
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
  if (!_fromEnsurePriceCoverage) {
    try {
      await ensurePriceCoverage([product], serpTrace, { force });
    } catch (e) {
      // best-effort: SerpAPI may be disabled
    }
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

/**
 * PERF-001: Parallel price enrichment.
 * All 3 sources (SerpAPI/Coverage, eBay Browse, Web) run in parallel instead of waterfall.
 * First successful hit with highest confidence wins.
 * @param {object} product
 * @param {{ force?: boolean, reason?: string }} opts
 */
async function enrichPriceParallel(product, { force = false, reason = 'identify' } = {}) {
  if (!product) return { ok: false, updated: false, error: 'product_missing' };
  product.details = product.details || {};
  product.details.pricing = product.details.pricing || {};

  const existing = product.details?.pricing?.lowest_price;
  if (!force && hasValidPriceEvidence(existing)) {
    return { ok: true, updated: false };
  }

  const serpTrace = [];

  // All 3 sources run in PARALLEL (not waterfall)
  const [serpResult, browseResult, webResult] = await Promise.allSettled([
    // Source 1: SerpAPI/Coverage
    (async () => {
      try {
        // Clone product to avoid mutation conflicts between parallel sources
        const shadowProduct = JSON.parse(JSON.stringify(product));
        shadowProduct.details = shadowProduct.details || {};
        shadowProduct.details.pricing = shadowProduct.details.pricing || {};
        await ensurePriceCoverage([shadowProduct], serpTrace, { force });
        const price = shadowProduct.details?.pricing?.lowest_price;
        if (hasValidPriceEvidence(price)) return { ok: true, price, via: 'serpapi', confidence: 0.8 };
      } catch {}
      return { ok: false };
    })(),
    // Source 2: eBay Browse API
    (async () => {
      try {
        const browse = await findEbayBrowsePriceForProductV1(product);
        if (browse.ok && browse.amount && Array.isArray(browse.sources) && browse.sources.length) {
          return {
            ok: true,
            price: {
              amount: browse.amount,
              currency: 'EUR',
              sources: browse.sources,
              last_checked_iso: new Date().toISOString(),
            },
            via: 'ebay_browse',
            confidence: 0.7,
            meta: browse.meta,
          };
        }
      } catch {}
      return { ok: false };
    })(),
    // Source 3: Web Price Search
    (async () => {
      try {
        const web = await findWebPriceForProductV1(product);
        if (web.ok && web.amount && Array.isArray(web.sources) && web.sources.length) {
          return {
            ok: true,
            price: {
              amount: web.amount,
              currency: 'EUR',
              sources: web.sources,
              last_checked_iso: new Date().toISOString(),
            },
            via: 'web',
            confidence: 0.75,
            meta: { query: web.usedQuery, engine: web.usedEngine },
          };
        }
      } catch {}
      return { ok: false };
    })(),
  ]);

  // Pick the best result (highest confidence)
  const results = [serpResult, browseResult, webResult]
    .filter((r) => r.status === 'fulfilled' && r.value.ok)
    .map((r) => r.value)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  if (!results.length) {
    product.notes = product.notes || {};
    product.notes.warnings = Array.from(
      new Set([...(product.notes.warnings || []), 'Preis konnte nicht zuverlässig ermittelt werden – bitte prüfen.'])
    );
    return { ok: false, updated: false, error: 'no_price_found', serpTrace };
  }

  const best = results[0];
  product.details.pricing.lowest_price = best.price;
  product.details.pricing.price_confidence = best.confidence;
  product.ops = product.ops || {};
  product.ops.data_quality = product.ops.data_quality || {};
  product.ops.data_quality.price_enrich_v1 = {
    at_iso: new Date().toISOString(),
    via: best.via,
    reason,
    sources: (best.price.sources || []).map((s) => s?.url).filter(Boolean).slice(0, 6),
  };

  return { ok: true, updated: true, serpTrace };
}

module.exports = {
  enrichPriceForProductBestEffort,
  enrichPriceParallel,
  // Exported for testing the BUG-089/BUG-093 product-match gate.
  findEbayBrowsePriceForProductV1,
  browseSampleMatchesProduct,
  buildBrowseMatchDescriptor,
  // Exported for testing the evidence skip-gate (Incident 2026-07-11).
  hasValidPriceEvidence,
};
