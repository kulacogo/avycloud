'use strict';

/**
 * price-evidence.js — Beleg-Validierung für Preis-Quellen.
 *
 * INCIDENT 2026-07-11: Die Chat-Pipelines schrieben Modell-ERFUNDENE Quell-URLs
 * in details.pricing.lowest_price.sources (z. B. eine 404-Herstellerseite als
 * "HOMEDEMO Official Shop" mit falschem Varianten-Preis 61,99 statt 105,99),
 * und die SerpAPI-Pfade schrieben Such-/Thumbnail-URLs als "Quellen"
 * (Bestandsaudit: 513 Such-URLs + ~320 gstatic-Thumbnails von 1943 Einträgen).
 * Nichts hat je geprüft, ob eine Quelle (a) überhaupt eine Angebotsseite ist,
 * (b) erreichbar ist, (c) den behaupteten Preis enthält, (d) zum Produkt passt.
 *
 * Zwei Schichten:
 *   1. classifyPriceSourceUrl / filterStructurallySound — PURE, ohne I/O:
 *      Such-URLs, Bild-CDNs und Nicht-URLs sind NIE ein Preisbeleg.
 *   2. verifyPriceSources — Netz: lädt Kandidaten-Seiten (fetchPageText mit
 *      Unlocker-Fallback) und verlangt: HTTP ok + behaupteter Preis auf der
 *      Seite + Marken-/Produkt-Bezug im Text.
 */

const STOPWORDS = new Set([
  'der', 'die', 'das', 'und', 'mit', 'für', 'fuer', 'von', 'aus', 'ohne', 'bei',
  'the', 'and', 'with', 'for', 'from', 'set', 'neu', 'new', 'stück', 'stueck',
]);

// Bild-/Thumbnail-CDNs — führen nie zu einer Angebotsseite.
const IMAGE_CDN_HOSTS = [
  /(^|\.)gstatic\.com$/i,
  /(^|\.)googleusercontent\.com$/i,
  /(^|\.)ggpht\.com$/i,
];

// Such-/Kategorie-/Vergleichs-Seiten: listen viele Produkte, belegen keinen Preis.
const SEARCH_URL_PATTERNS = [
  /ebay\.[a-z.]+\/sch\//i,
  /[?&]_nkw=/i,
  /amazon\.[a-z.]+\/s([/?]|$)/i,
  /idealo\.[a-z.]+\/preisvergleich\/MainSearch/i,
  /kaufland\.[a-z.]+\/item\/search\//i,
  /google\.[a-z.]+\/(search|shopping)/i,
  /bing\.[a-z.]+\/(search|shop)/i,
  /picclick\.[a-z.]+\/?$/i,
  /\/search([/?]|$)/i,
  /[?&](q|query|search|search_value|searchterm)=/i,
  /\/collections?\//i,
];

const IMAGE_FILE_RE = /\.(jpe?g|png|gif|webp|svg)([?#]|$)/i;

/**
 * Klassifiziert eine einzelne Quell-URL. PURE — kein I/O.
 * @returns {{ kind: 'candidate'|'search'|'image'|'invalid', reason: string }}
 */
function classifyPriceSourceUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) return { kind: 'invalid', reason: 'empty' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'invalid', reason: 'not_a_url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'invalid', reason: 'non_http' };
  }
  const host = parsed.hostname.replace(/^www\./i, '');
  if (!host.includes('.')) return { kind: 'invalid', reason: 'invalid_host' };
  if (IMAGE_CDN_HOSTS.some((re) => re.test(host))) return { kind: 'image', reason: 'image_cdn' };
  if (IMAGE_FILE_RE.test(parsed.pathname)) return { kind: 'image', reason: 'image_file' };
  if (SEARCH_URL_PATTERNS.some((re) => re.test(url))) return { kind: 'search', reason: 'search_or_category_page' };
  return { kind: 'candidate', reason: 'ok' };
}

/**
 * Trennt ein sources-Array in strukturell taugliche Kandidaten und Ausschuss.
 * PURE — kein I/O.
 */
function filterStructurallySound(sources) {
  const candidates = [];
  const dropped = [];
  for (const src of Array.isArray(sources) ? sources : []) {
    const cls = classifyPriceSourceUrl(src && src.url);
    if (cls.kind === 'candidate') candidates.push(src);
    else dropped.push({ source: src, kind: cls.kind, reason: cls.reason });
  }
  return { candidates, dropped };
}

/**
 * Signifikante Produkt-Tokens für den Relevanz-Check (Marke separat).
 */
function significantTitleTokens(product) {
  const title = String(product?.identification?.name || '');
  return title
    .toLowerCase()
    .split(/[^a-z0-9äöüß]+/i)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t))
    .slice(0, 12);
}

/**
 * Alle textuellen Schreibweisen eines Preises (deutsch + englisch), für
 * "steht der behauptete Preis auf der Seite?".
 */
function priceTextVariants(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return [];
  const fixed = n.toFixed(2); // "105.99"
  const [euros, cents] = fixed.split('.');
  const eurosGrouped = euros.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const variants = new Set([
    `${euros},${cents}`,           // 105,99
    `${euros}.${cents}`,           // 105.99
    `${eurosGrouped},${cents}`,    // 1.234,56
  ]);
  if (cents === '00') {
    variants.add(String(euros));   // "105" bei glatten Beträgen
  }
  return Array.from(variants);
}

/**
 * Prüft einen geladenen Seitentext gegen Produkt + behaupteten Preis.
 * PURE — kein I/O. Exportiert für Tests.
 *
 * @returns {{ ok: boolean, reason: string }}
 */
function evaluatePageEvidence({ text, html, product, claimedPrice }) {
  const body = String(text || '').toLowerCase();
  // JS-lastige Shops (z. B. Shopify) tragen den Preis oft NUR im eingebetteten
  // JSON/Meta ("price":10599, og:price content="105.99") — der sichtbare Text
  // verliert ihn bei der HTML-zu-Text-Extraktion. Deshalb wird zusätzlich das
  // Roh-HTML durchsucht (Dezimal-Varianten; bewusst KEINE nackte Cent-Form wie
  // "10599" — das wäre z. B. auch eine Berliner Postleitzahl).
  const raw = String(html || '').toLowerCase();
  const haystack = raw ? `${body}\n${raw}` : body;
  if (!haystack || haystack.length < 200) return { ok: false, reason: 'page_empty' };

  // 1. Produkt-Bezug: Marke ODER MPN ODER >=2 signifikante Titel-Tokens.
  const brand = String(product?.identification?.brand || '').trim().toLowerCase();
  const mpn = String(product?.details?.identifiers?.mpn || '').trim().toLowerCase();
  const brandHit = brand.length >= 3 && haystack.includes(brand);
  const mpnHit = mpn.length >= 4 && haystack.includes(mpn);
  const tokens = significantTitleTokens(product);
  const tokenHits = tokens.filter((t) => haystack.includes(t)).length;
  if (!brandHit && !mpnHit && tokenHits < 2) {
    return { ok: false, reason: 'page_not_about_product' };
  }

  // 2. Preis-Bezug: der behauptete Preis muss auf der Seite stehen.
  const variants = priceTextVariants(claimedPrice);
  if (!variants.length) return { ok: false, reason: 'no_claimed_price' };
  const priceHit = variants.some((v) => haystack.includes(v));
  if (!priceHit) return { ok: false, reason: 'claimed_price_not_on_page' };

  return { ok: true, reason: 'verified' };
}

/**
 * Robuster Seiten-Abruf für die Verifikation: erst der Standard-Weg
 * (fetchPageText, im Prod-Default via BrightData-Unlocker), bei Fehlschlag
 * ein einfacher Direkt-GET. Grund: der Unlocker kann ausfallen (401/Quota) —
 * dann würde ohne Fallback KEINE Quelle mehr verifizierbar sein und jede
 * ehrliche Recherche fälschlich als "unbelegt" enden. Viele Shop-Seiten
 * beantworten einen simplen GET problemlos.
 */
const MAX_HTML_BYTES = 1_500_000; // Roh-HTML-Kappe (Shopify-Produktseiten ~800KB)

async function fetchPageForVerification(url, { timeoutMs = 15_000 } = {}) {
  const { fetchText, htmlToText } = require('./web-search-html');
  try {
    const viaUnlocker = await fetchText(url, { timeoutMs });
    if (viaUnlocker && viaUnlocker.ok && viaUnlocker.body) {
      const html = String(viaUnlocker.body).slice(0, MAX_HTML_BYTES);
      return { ok: true, status: viaUnlocker.status, text: htmlToText(html), html, via: viaUnlocker.via, url };
    }
  } catch { /* fällt auf Direkt-GET zurück */ }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
          'Accept-Language': 'de-DE,de;q=0.9',
        },
      });
      const html = res.ok ? String(await res.text()).slice(0, MAX_HTML_BYTES) : '';
      return { ok: res.ok, status: res.status, text: res.ok ? htmlToText(html) : '', html, via: 'direct', url };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, status: 0, text: '', html: '', via: 'direct_failed', error: err.message, url };
  }
}

/**
 * Verifiziert Kandidaten-Quellen per echtem Seiten-Abruf.
 * fetchPage ist injizierbar für Tests (default fetchPageForVerification).
 * @returns {Promise<{ verified: Array, failed: Array }>}
 */
async function verifyPriceSources({
  sources,
  product,
  fallbackAmount,
  maxPages = 3,
  timeoutMs = 15_000,
  fetchPage,
} = {}) {
  const fetcher = fetchPage || fetchPageForVerification;
  const verified = [];
  const failed = [];
  const list = (Array.isArray(sources) ? sources : []).slice(0, maxPages);

  await Promise.all(list.map(async (src) => {
    const url = String(src && src.url || '');
    const claimedPrice = Number(src && src.price) > 0 ? Number(src.price) : Number(fallbackAmount) || 0;
    try {
      const page = await fetcher(url, { timeoutMs });
      if (!page || !page.ok) {
        failed.push({ source: src, reason: `fetch_failed_${page && page.status || 0}` });
        return;
      }
      const check = evaluatePageEvidence({ text: page.text, html: page.html, product, claimedPrice });
      if (check.ok) {
        verified.push({ ...src, verified: true, verified_at: new Date().toISOString() });
      } else {
        failed.push({ source: src, reason: check.reason });
      }
    } catch (err) {
      failed.push({ source: src, reason: `fetch_error:${err.message}` });
    }
  }));

  // Über der Kappe liegende Quellen gelten als ungeprüft-verworfen (ehrlich bleiben).
  for (const src of (Array.isArray(sources) ? sources : []).slice(maxPages)) {
    failed.push({ source: src, reason: 'not_checked_cap' });
  }

  return { verified, failed };
}

/**
 * Orchestrierung für Preis-Änderungsvorschläge (Chat-Chokepoint).
 *
 * Nimmt ein vorgeschlagenes pricing-Objekt (V2/Legacy-Shape mit
 * lowest_price.sources ODER bereits normalisiert), validiert die Quellen und
 * liefert ein bereinigtes pricing zurück:
 *   - strukturell untaugliche Quellen (Suche/Bild/Nicht-URL) fliegen immer raus
 *   - Kandidaten werden per Seiten-Abruf verifiziert
 *   - ohne EINE verifizierte Quelle: sources=[], price_confidence<=0.3,
 *     evidence_check dokumentiert das Ergebnis (Operator sieht ehrlich "unbelegt")
 *
 * @returns {Promise<{ pricing: object, verifiedCount: number, droppedCount: number, note: string|null }>}
 */
async function validatePricingProposal({ pricing, product, fetchPage, maxPages, timeoutMs } = {}) {
  if (!pricing || typeof pricing !== 'object') {
    return { pricing, verifiedCount: 0, droppedCount: 0, note: null };
  }
  const out = JSON.parse(JSON.stringify(pricing));

  // V3 liefert flach: { amount, currency, source_url } — auf die kanonische
  // Quellen-Form heben, damit dieselbe Validierung greift.
  let flatShape = false;
  if (!out.lowest_price && typeof out.source_url === 'string' && out.source_url.trim()) {
    flatShape = true;
    out.lowest_price = {
      amount: Number(out.amount) || 0,
      currency: out.currency || 'EUR',
      sources: [{
        name: 'KI-Recherche',
        url: out.source_url.trim(),
        price: Number(out.amount) || 0,
        checked_at: new Date().toISOString(),
      }],
    };
  }

  const lp = out.lowest_price && typeof out.lowest_price === 'object' ? out.lowest_price : null;
  const sources = lp && Array.isArray(lp.sources) ? lp.sources : [];
  if (!lp || sources.length === 0) {
    // Kein Quellen-Anspruch → nichts zu validieren; Confidence trotzdem deckeln,
    // denn ein Preis ohne Quellen ist per Definition unbelegt.
    if (lp && Number(out.price_confidence) > 0.3) out.price_confidence = 0.3;
    return { pricing: out, verifiedCount: 0, droppedCount: 0, note: null };
  }

  const { candidates, dropped } = filterStructurallySound(sources);
  const { verified, failed } = await verifyPriceSources({
    sources: candidates,
    product,
    fallbackAmount: lp.amount,
    fetchPage,
    maxPages,
    timeoutMs,
  });

  const droppedCount = dropped.length + failed.length;
  lp.sources = verified;
  lp.evidence_check = {
    checked_at: new Date().toISOString(),
    verified: verified.length,
    dropped: droppedCount,
    dropped_reasons: [
      ...dropped.map((d) => `${d.kind}:${d.reason}`),
      ...failed.map((f) => f.reason),
    ].slice(0, 10),
  };

  let note = null;
  if (verified.length === 0) {
    out.price_confidence = Math.min(Number(out.price_confidence) || 0, 0.3);
    if (flatShape) delete out.source_url; // erfundene Flach-URL nicht durchreichen
    note = 'Keine der angegebenen Preisquellen konnte verifiziert werden (Seite nicht erreichbar, Preis nicht auf der Seite oder themenfremd). Der Preis wurde als UNBELEGT markiert — bitte manuell prüfen.';
  } else if (droppedCount > 0) {
    note = `${droppedCount} von ${sources.length} Preisquellen wurden verworfen (nicht verifizierbar); ${verified.length} Quelle(n) bestätigt.`;
  }

  return { pricing: out, verifiedCount: verified.length, droppedCount, note };
}

module.exports = {
  fetchPageForVerification,
  classifyPriceSourceUrl,
  filterStructurallySound,
  evaluatePageEvidence,
  priceTextVariants,
  verifyPriceSources,
  validatePricingProposal,
};
