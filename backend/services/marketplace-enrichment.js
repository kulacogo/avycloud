/* eslint-disable no-console */
/**
 * Marketplace enrichment (web-only).
 *
 * - Uses BrightData SERP (via evidence-provider) + BrightData Web Unlocker (raw HTML fetch)
 * - Targets: ebay.de, kaufland.de, hood.de
 * - Extracts structured facts primarily from JSON-LD (schema.org Product) + OpenGraph
 *
 * IMPORTANT:
 * - No LLM usage here.
 * - No SerpAPI usage here.
 */
const { searchSite, fetchText } = require('../lib/evidence-provider');
const { fetchWithUnlocker } = require('../lib/web-unlocker');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeSpaces(text = '') {
  return safeString(text).replace(/\s+/g, ' ').trim();
}

function tryParseJson(text = '') {
  if (!text) return null;
  const s = String(text).trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractTitleTag(html = '') {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m || !m[1]) return '';
  return normalizeSpaces(m[1].replace(/<[^>]+>/g, ' '));
}

function extractMetaContent(html = '', { property = null, name = null } = {}) {
  const h = String(html || '');
  if (property) {
    const re = new RegExp(
      `<meta[^>]+property=["']${property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      'i'
    );
    const m = h.match(re);
    return m && m[1] ? normalizeSpaces(m[1]) : '';
  }
  if (name) {
    const re = new RegExp(
      `<meta[^>]+name=["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      'i'
    );
    const m = h.match(re);
    return m && m[1] ? normalizeSpaces(m[1]) : '';
  }
  return '';
}

function extractJsonLdBlocks(html = '') {
  const h = String(html || '');
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(h))) {
    const raw = m[1] ? m[1].trim() : '';
    if (!raw) continue;
    // Some sites include multiple JSON objects without valid JSON; we only accept valid JSON.
    const parsed = tryParseJson(raw);
    if (parsed != null) blocks.push(parsed);
  }
  return blocks;
}

function flattenJsonLd(node) {
  if (node == null) return [];
  if (Array.isArray(node)) return node.flatMap(flattenJsonLd);
  if (typeof node !== 'object') return [];
  // Handle @graph
  if (Array.isArray(node['@graph'])) return flattenJsonLd(node['@graph']);
  return [node];
}

function pickJsonLdProducts(jsonLdBlocks = []) {
  const nodes = jsonLdBlocks.flatMap(flattenJsonLd);
  const products = [];
  for (const n of nodes) {
    const t = n && (n['@type'] || n.type);
    const type = Array.isArray(t) ? t[0] : t;
    if (!type) continue;
    if (String(type).toLowerCase() !== 'product') continue;
    products.push(n);
  }
  return products;
}

function normalizeBrand(value) {
  if (!value) return '';
  if (typeof value === 'string') return normalizeSpaces(value);
  if (typeof value === 'object') {
    return normalizeSpaces(value.name || value.brand || '');
  }
  return '';
}

function normalizeIdentifiersFromJsonLd(productJsonLd = {}) {
  const ids = {};
  const pick = (k) => safeString(productJsonLd?.[k]);
  const gtin14 = pick('gtin14');
  const gtin13 = pick('gtin13');
  const gtin12 = pick('gtin12');
  const mpn = pick('mpn');
  const sku = pick('sku');
  if (gtin13) ids.ean = gtin13;
  if (gtin14) ids.gtin = gtin14;
  if (gtin12) ids.upc = gtin12;
  if (mpn) ids.mpn = mpn;
  if (sku) ids.sku = sku;
  return ids;
}

function normalizeAdditionalProperties(productJsonLd = {}) {
  const props = productJsonLd?.additionalProperty;
  const out = [];
  if (!props) return out;
  const arr = Array.isArray(props) ? props : [props];
  for (const p of arr) {
    if (!p || typeof p !== 'object') continue;
    const key = normalizeSpaces(p.name || p.propertyID || p.propertyId || '');
    const value = normalizeSpaces(p.value || p.valueText || p.description || '');
    if (!key || !value) continue;
    out.push({ key, value });
  }
  return out;
}

function guessSite(url = '') {
  try {
    const host = new URL(url).host.toLowerCase();
    if (host.endsWith('ebay.de')) return 'ebay.de';
    if (host.endsWith('kaufland.de')) return 'kaufland.de';
    if (host.endsWith('hood.de')) return 'hood.de';
    return host;
  } catch {
    return '';
  }
}

async function fetchHtml(url, { timeoutMs = 45_000 } = {}) {
  const u = safeString(url);
  if (!u) return { ok: false, url: '', status: 0, via: null, html: '', error: 'url_empty' };
  // Always prefer Unlocker for marketplaces (bot protection).
  try {
    const res = await fetchWithUnlocker({
      url: u,
      method: 'GET',
      format: 'raw',
      timeoutMs,
      headers: {
        'User-Agent': 'avystock-marketplace-enrich/1.0',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7',
      },
    });
    const ok = Boolean(res?.success);
    const html = typeof res?.body === 'string' ? res.body : '';
    return {
      ok,
      url: u,
      status: res?.status || 0,
      via: 'unlocker',
      html,
      error: ok ? null : res?.statusText || res?.error || 'fetch_failed',
    };
  } catch (e) {
    return { ok: false, url: u, status: 0, via: 'unlocker', html: '', error: e?.message || String(e) };
  }
}

function scoreCandidate({ url = '', title = '', product = null }, { barcode = '', brand = '', mpn = '' } = {}) {
  const u = safeString(url).toLowerCase();
  const t = safeString(title).toLowerCase();
  const b = safeString(brand).toLowerCase();
  const m = safeString(mpn).toLowerCase();
  const code = safeString(barcode).replace(/[^\d]/g, '');
  const ids = normalizeIdentifiersFromJsonLd(product || {});
  const jsonIds = Object.values(ids).map((x) => safeString(x).replace(/[^\d]/g, ''));

  let score = 0;
  // prefer target marketplaces
  if (u.includes('ebay.de')) score += 6;
  if (u.includes('kaufland.de')) score += 6;
  if (u.includes('hood.de')) score += 6;
  // product-page-ish heuristics
  if (/\/itm\//.test(u)) score += 4;
  if (/\/p\//.test(u) || /\/produkt\//.test(u) || /\/product\//.test(u)) score += 2;

  if (code) {
    if (jsonIds.some((x) => x && x === code)) score += 40;
    if (t.includes(code)) score += 20;
    if (u.includes(code)) score += 8;
  }
  if (b) {
    if (t.includes(b)) score += 10;
    const jsonBrand = normalizeBrand(product?.brand).toLowerCase();
    if (jsonBrand && jsonBrand.includes(b)) score += 12;
  }
  if (m) {
    if (t.includes(m)) score += 12;
    const jsonMpn = safeString(product?.mpn).toLowerCase();
    if (jsonMpn && jsonMpn.includes(m)) score += 14;
  }
  // Penalize super-generic pages
  if (u.includes('/suche') || u.includes('/search')) score -= 10;
  return score;
}

function normalizeToProductPatch(best, { fallbackQuery = '' } = {}) {
  const patch = {
    identification: {},
    details: {},
    evidence: {},
  };

  const url = best?.url || '';
  const site = guessSite(url);
  const jsonProduct = best?.jsonProduct || null;
  const title =
    safeString(best?.ogTitle) ||
    safeString(jsonProduct?.name) ||
    safeString(best?.titleTag) ||
    safeString(best?.pageTitle) ||
    '';
  const description =
    safeString(best?.ogDescription) ||
    safeString(jsonProduct?.description) ||
    '';
  const brand =
    safeString(best?.brand) ||
    normalizeBrand(jsonProduct?.brand) ||
    '';

  const ids = normalizeIdentifiersFromJsonLd(jsonProduct || {});
  const attributes = normalizeAdditionalProperties(jsonProduct || {});

  patch.identification.name = title;
  patch.identification.brand = brand;
  // category enrichment is handled elsewhere (taxonomy), we keep evidence only
  patch.details.short_description = description;
  patch.details.identifiers = ids;
  patch.details.attributes = attributes;
  patch.evidence = {
    site,
    url,
    query: fallbackQuery || '',
    extracted_from: 'jsonld+og',
  };
  return patch;
}

async function enrichFromMarketplaces(query, { barcode = '', brand = '', mpn = '', limitPerSite = 4 } = {}) {
  const q = safeString(query);
  if (!q) {
    return { ok: false, query: '', best: null, candidates: [], error: 'query_empty' };
  }

  const targets = ['ebay.de', 'kaufland.de', 'hood.de'];
  const searchResults = [];
  for (const site of targets) {
    // site search via BrightData SERP-backed search
    // eslint-disable-next-line no-await-in-loop
    const res = await searchSite(q, site, { limit: limitPerSite, locale: 'de-DE' });
    if (res?.ok && Array.isArray(res.results)) {
      res.results.forEach((r) => {
        if (r?.url) searchResults.push({ site, url: r.url, title: r.title || '' });
      });
    }
  }

  const unique = [];
  const seen = new Set();
  for (const r of searchResults) {
    const u = safeString(r.url);
    if (!u) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    unique.push(r);
  }
  const urls = unique.slice(0, 9);

  const candidates = [];
  for (const entry of urls) {
    // eslint-disable-next-line no-await-in-loop
    const fetched = await fetchHtml(entry.url, { timeoutMs: 45_000 });
    if (!fetched.ok || !fetched.html) {
      candidates.push({
        url: entry.url,
        site: entry.site,
        ok: false,
        status: fetched.status,
        error: fetched.error || 'fetch_failed',
        score: -999,
      });
      continue;
    }

    const html = fetched.html;
    const titleTag = extractTitleTag(html);
    const ogTitle = extractMetaContent(html, { property: 'og:title' }) || '';
    const ogDescription = extractMetaContent(html, { property: 'og:description' }) || extractMetaContent(html, { name: 'description' }) || '';
    const jsonLdBlocks = extractJsonLdBlocks(html);
    const jsonProducts = pickJsonLdProducts(jsonLdBlocks);
    const jsonProduct = jsonProducts[0] || null;
    const pageTitle = safeString(entry.title);
    const brandFromJson = normalizeBrand(jsonProduct?.brand);

    const score = scoreCandidate(
      { url: entry.url, title: ogTitle || titleTag || pageTitle, product: jsonProduct },
      { barcode, brand, mpn }
    );

    candidates.push({
      url: entry.url,
      site: entry.site,
      ok: true,
      status: fetched.status,
      titleTag,
      ogTitle,
      ogDescription,
      pageTitle,
      jsonProduct,
      brand: brandFromJson,
      score,
    });
  }

  const sorted = candidates
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  const best = sorted.find((c) => c.ok && c.score > 0) || sorted.find((c) => c.ok) || null;
  if (!best) {
    return { ok: false, query: q, best: null, candidates, error: 'no_candidates' };
  }

  const patch = normalizeToProductPatch(best, { fallbackQuery: q });
  return {
    ok: true,
    query: q,
    best: { ...best, patch },
    candidates: candidates.slice(0, 9),
    error: null,
  };
}

module.exports = {
  enrichFromMarketplaces,
};

