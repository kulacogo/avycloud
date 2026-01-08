/* eslint-disable no-console */
/**
 * Backfill missing barcodes (EAN/GTIN/UPC) using web evidence WITHOUT SerpAPI.
 *
 * Approach:
 * - Build a query from product signals (brand/mpn/title).
 * - Search the web via DuckDuckGo HTML endpoint (best-effort; not an official API).
 * - Fetch top result pages (direct fetch; optionally via BrightData Web Unlocker if configured).
 * - Extract numeric candidates (8/12/13/14 digits) and keep only valid GTINs (checkdigit).
 * - Ask Gemini to choose ONLY from the candidate list, based on the provided evidence.
 * - Persist only when chosen code is valid and supported by evidence; otherwise leave empty.
 *
 * Safety:
 * - Dry-run by default.
 * - Never overwrites existing valid barcodes.
 * - Count guard (no create/delete).
 *
 * Usage:
 *   node backend/scripts/backfill-missing-barcodes-with-web.js --dry-run --limit 10
 *   node backend/scripts/backfill-missing-barcodes-with-web.js --apply --expected-count 420 --concurrency 2
 *
 * Env:
 * - BARCODE_WEB_USE_UNLOCKER=true  (optional; uses BrightData Web Unlocker for blocked pages)
 */

const fs = require('fs');
const path = require('path');
// Node 18+ provides global fetch. Keep node-fetch optional for older runtimes.
const fetch = global.fetch || require('node-fetch');
const PQueue = require('p-queue').default || require('p-queue');
const { getAllProducts, getProduct, saveProduct } = require('../lib/firestore');
const { isValidGtin, getGtinType, normalizeDigits } = require('../lib/gtin');
const { fetchWithUnlocker } = require('../lib/web-unlocker');
const { getGeminiClient } = require('../lib/gemini-client');
const { resolveModel } = require('../lib/model-select');
const { buildCommonPolicyText } = require('../lib/llm-policy-pack');

const USE_UNLOCKER =
  (process.env.BARCODE_WEB_USE_UNLOCKER || '').toString().toLowerCase() === 'true';

// Some "EAN search" sites list random codes unrelated to the searched product.
// We exclude them to reduce false candidates.
const DOMAIN_BLOCKLIST = new Set([
  'www.ean1.de',
  'ean1.de',
  'www.ean-suche.de',
  'ean-suche.de',
  'www.ean-suche.com',
  'ean-suche.com',
]);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeSpaces(text = '') {
  return safeString(text).replace(/\s+/g, ' ').trim();
}

function hasAnyValidBarcode(product) {
  const ids = product?.details?.identifiers || {};
  const list = []
    .concat(Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [])
    .concat([ids.ean, ids.gtin, ids.upc])
    .filter(Boolean)
    .map((v) => normalizeDigits(String(v)));
  return list.some((c) => c && [8, 12, 13, 14].includes(c.length) && isValidGtin(c));
}

function pickQuery(product) {
  const ids = product?.details?.identifiers || {};
  const attrs = product?.details?.attributes || {};
  const brand = safeString(product?.identification?.brand);
  const mpn = safeString(ids.mpn) || safeString(attrs.Herstellernummer);
  const title = safeString(product?.identification?.name);
  const titleTokens = title
    .replace(/\b(SKU[\s\-_]?\d+)\b/gi, ' ')
    .replace(/\b(NEU|OVP|Original|Gebraucht|Used|Refurbished|Refurb)\b/gi, ' ')
    // Drop common size/dimension patterns (rarely helpful for barcode search)
    .replace(/\b\d+\s*[x×]\s*\d+(\s*[x×]\s*\d+)?\s*(cm|mm|m)\b/gi, ' ')
    .replace(/\b\d+(?:[.,]\d+)?\s*(cm|mm|m|inch|zoll)\b/gi, ' ')
    .replace(/\bgr\.\s*\d+[^\s]*\b/gi, ' ')
    .replace(/[^\p{L}\p{N}\s\-+./]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t.length >= 3)
    .slice(0, 4)
    .join(' ');

  const build = (...parts) => normalizeSpaces(parts.filter(Boolean).join(' '));
  if (brand && mpn && titleTokens) return build(brand, mpn, titleTokens, 'EAN');
  if (brand && mpn) return build(brand, mpn, 'EAN');
  if (mpn) return build(mpn, 'EAN');
  if (brand && title) return build(brand, title.split(/\s+/).slice(0, 8).join(' '), 'EAN');
  return build(title.split(/\s+/).slice(0, 10).join(' '), 'EAN');
}

function decodeHtmlEntities(text = '') {
  return String(text)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function htmlToText(html = '') {
  const cleaned = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/?(?:div|p|br|li|ul|ol|h\d|tr|td|th|table)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return normalizeSpaces(decodeHtmlEntities(cleaned)).slice(0, 250_000);
}

async function fetchTextDirect(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7',
      },
      signal: controller.signal,
    });
    const text = await res.text();
    // NOTE: Some providers return HTTP 202 as a bot-defense / challenge page.
    // Treat it as "not ok" so we can fall back to the Web Unlocker.
    const ok = res.ok && res.status !== 202;
    return { ok, status: res.status, body: text };
  } catch (e) {
    return { ok: false, status: 0, body: '', error: e.message };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url) {
  const direct = await fetchTextDirect(url);
  if (direct.ok && direct.body) return { ...direct, via: 'direct' };
  if (!USE_UNLOCKER) return { ...direct, via: 'direct' };
  try {
    const unlocked = await fetchWithUnlocker({ url, timeoutMs: 30_000 });
    if (unlocked?.success && unlocked?.body) {
      return { ok: true, status: unlocked.status, body: unlocked.body, via: 'unlocker' };
    }
    return { ok: false, status: unlocked?.status || 0, body: unlocked?.body || '', via: 'unlocker' };
  } catch (e) {
    return { ...direct, via: 'direct+unlocker_failed', unlockerError: e.message };
  }
}

async function searchDuckDuckGo(query, { limit = 6 } = {}) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchText(url);
  if (!res.ok || !res.body) {
    return { query, ok: false, url, via: res.via, status: res.status, results: [] };
  }

  const html = res.body;
  const results = [];
  // DDG markup typically uses: <a rel="nofollow" class="result__a" href="...">...</a>
  // Attribute order is not guaranteed → match class first, then href.
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const href = m[1];
    const title = normalizeSpaces(decodeHtmlEntities(m[2].replace(/<[^>]+>/g, ' ')));
    let outUrl = href;
    // DDG often wraps URLs like /l/?uddg=<encoded>
    const uddg = href.match(/[?&]uddg=([^&]+)/i);
    if (uddg && uddg[1]) {
      try {
        outUrl = decodeURIComponent(uddg[1]);
      } catch {
        outUrl = href;
      }
    }
    if (!outUrl || !/^https?:\/\//i.test(outUrl)) continue;
    if (/\.(pdf|jpg|jpeg|png|webp)(\?|$)/i.test(outUrl)) continue;
    try {
      const host = new URL(outUrl).host.toLowerCase();
      if (DOMAIN_BLOCKLIST.has(host)) continue;
      // Skip DDG internal ad/click trackers and other redirectors.
      if (host.endsWith('duckduckgo.com')) continue;
      if (host === 'bing.com' || host === 'www.bing.com') continue;
      if (/\/aclick/i.test(outUrl)) continue;
    } catch {
      // ignore
    }
    results.push({ title, url: outUrl });
    if (results.length >= limit) break;
  }
  return { query, ok: true, url, via: res.via, status: res.status, results };
}

async function searchGoogle(query, { limit = 6 } = {}) {
  const trimmedQuery = safeString(query).slice(0, 140);
  const url = `https://www.google.com/search?q=${encodeURIComponent(trimmedQuery)}&hl=de&gl=de`;
  try {
    // Google SERP is frequently blocked for direct fetch; use BrightData unlocker when enabled.
    const fetched = USE_UNLOCKER
      ? await fetchWithUnlocker({ url, timeoutMs: 45_000 })
      : await fetchText(url);
    const html = USE_UNLOCKER ? String(fetched?.body || '') : String(fetched?.body || '');
    const ok = USE_UNLOCKER ? Boolean(fetched?.success) : Boolean(fetched?.ok);
    const status = USE_UNLOCKER ? fetched?.status || 0 : fetched?.status || 0;
    if (!ok || !html) {
      return { query: trimmedQuery, ok: false, url, via: USE_UNLOCKER ? 'unlocker' : 'direct', status, results: [], error: fetched?.error || null };
    }

    const results = [];
    const seen = new Set();
    // Newer Google SERP variants include outbound links directly as absolute href="https://...".
    // We keep a conservative filter to avoid google internal links and trackers.
    const re = /href="(https?:\/\/[^"]+)"/gi;
    let m;
    while ((m = re.exec(html))) {
      let outUrl = decodeHtmlEntities(m[1] || '').replace(/&amp;/g, '&');
      if (!outUrl || !/^https?:\/\//i.test(outUrl)) continue;
      if (/\.(pdf|jpg|jpeg|png|webp)(\?|$)/i.test(outUrl)) continue;
      // Deduplicate
      if (seen.has(outUrl)) continue;
      try {
        const parsed = new URL(outUrl);
        const host = parsed.host.toLowerCase();
        if (DOMAIN_BLOCKLIST.has(host)) continue;
        // Skip Google-owned and common internal targets
        if (
          host.endsWith('google.com') ||
          host.endsWith('google.de') ||
          host.endsWith('gstatic.com') ||
          host.endsWith('googleusercontent.com') ||
          host.endsWith('accounts.google.com') ||
          host.endsWith('support.google.com') ||
          host.endsWith('translate.google.com')
        ) {
          continue;
        }
        // Skip obvious navigation / login / policy links
        if (
          /\/(search|webhp|preferences|policies|advanced_search|setprefs)/i.test(parsed.pathname) ||
          /accounts\.google\.com/i.test(outUrl)
        ) {
          continue;
        }
      } catch {
        // ignore
      }
      seen.add(outUrl);
      results.push({ title: '', url: outUrl });
      if (results.length >= limit) break;
    }
    return { query: trimmedQuery, ok: true, url, via: USE_UNLOCKER ? 'unlocker' : 'direct', status, results };
  } catch (e) {
    return { query: trimmedQuery, ok: false, url, via: USE_UNLOCKER ? 'unlocker' : 'direct', status: 0, results: [], error: e.message };
  }
}

function buildAnchorTokens(productSnapshot) {
  const STOP = new Set([
    'neu',
    'ovp',
    'original',
    'gebraucht',
    'used',
    'refurb',
    'refurbished',
    'rot',
    'schwarz',
    'weiß',
    'weiss',
    'blau',
    'grün',
    'gruen',
    'gelb',
    'grau',
    'beige',
    'pink',
    'lila',
    'gold',
    'silber',
    'braun',
    'cm',
    'mm',
    'm',
    'gr',
    'größe',
    'groesse',
    'ean',
    'gtin',
    'upc',
  ]);

  const strong = [];
  const weak = [];

  const pushTokens = (value, target) => {
    const s = safeString(value);
    if (!s) return;
    // Split on non-alphanumeric boundaries too (hyphens, slashes, etc.)
    s.split(/[^\\p{L}\\p{N}]+/gu).forEach((raw) => {
      const w = raw.trim().toLowerCase();
      if (!w) return;
      if (w.length < 3) return;
      if (STOP.has(w)) return;
      // Skip pure numbers and common dimension-ish patterns (e.g. 100x200)
      if (/^\\d+$/.test(w)) return;
      if (/^\\d{2,4}x\\d{2,4}$/.test(w)) return;
      target.push(w);
    });
  };

  // Strong anchors: brand / mpn / model (prefer these)
  pushTokens(productSnapshot?.brand, strong);
  pushTokens(productSnapshot?.mpn, strong);
  pushTokens(productSnapshot?.model, strong);

  // Weak anchors: product type + early title tokens (only as fallback)
  pushTokens(productSnapshot?.produktart, weak);
  const titleLead = safeString(productSnapshot?.title).split(/\s+/).slice(0, 10).join(' ');
  pushTokens(titleLead, weak);

  return {
    strong: Array.from(new Set(strong)).slice(0, 12),
    weak: Array.from(new Set(weak)).slice(0, 24),
  };
}

function pageHasAnchor(text = '', { strong = [], weak = [] } = {}) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  const hasStrong = strong.some((tok) => tok && t.includes(tok));
  if (strong.length) {
    // If we have strong anchors, require at least one to match to avoid poisoning.
    return hasStrong;
  }
  // Fallback: require at least 2 weak anchors to match.
  let weakHits = 0;
  for (const tok of weak) {
    if (!tok) continue;
    if (t.includes(tok)) weakHits += 1;
    if (weakHits >= 2) return true;
  }
  return false;
}

function extractGtinCandidatesFromText(text, { maxPerPage = 40 } = {}) {
  const t = String(text || '');
  const re = /\b\d{8}\b|\b\d{12}\b|\b\d{13}\b|\b\d{14}\b/g;
  const hits = [];
  let m;
  while ((m = re.exec(t))) {
    const code = m[0];
    if (!code) continue;
    if (!isValidGtin(code)) continue;
    const start = Math.max(0, m.index - 60);
    const end = Math.min(t.length, m.index + code.length + 60);
    const ctx = t.slice(start, end);
    const hasLabel = /\b(ean|gtin|upc|barcode|strichcode)\b/i.test(ctx);
    hits.push({ code, hasLabel, ctx: normalizeSpaces(ctx) });
    if (hits.length >= maxPerPage) break;
  }
  return hits;
}

function buildCandidateIndex(pages = [], { anchorTokens = [] } = {}) {
  const byCode = new Map(); // code -> { code, sources: Map<url, {hasLabel, contexts:[]}> }
  pages.forEach((page) => {
    const url = page.url;
    const text = page.text || '';
    // Drop pages that do not mention any anchor token for the product.
    if ((anchorTokens?.strong?.length || anchorTokens?.weak?.length) && !pageHasAnchor(text, anchorTokens)) return;
    const found = extractGtinCandidatesFromText(text);
    found.forEach((hit) => {
      if (!byCode.has(hit.code)) byCode.set(hit.code, { code: hit.code, sources: new Map() });
      const entry = byCode.get(hit.code);
      if (!entry.sources.has(url)) entry.sources.set(url, { hasLabel: false, contexts: [] });
      const s = entry.sources.get(url);
      s.hasLabel = s.hasLabel || Boolean(hit.hasLabel);
      if (s.contexts.length < 3) s.contexts.push(hit.ctx);
      entry.sources.set(url, s);
    });
  });

  const candidates = Array.from(byCode.values()).map((entry) => {
    const urls = Array.from(entry.sources.keys());
    const sourceCount = urls.length;
    const hasLabel = Array.from(entry.sources.values()).some((s) => s.hasLabel);
    return {
      code: entry.code,
      type: getGtinType(entry.code),
      sourceCount,
      hasLabel,
      sources: urls.map((u) => ({
        url: u,
        hasLabel: entry.sources.get(u).hasLabel,
        contexts: entry.sources.get(u).contexts,
      })),
    };
  });

  // Prefer codes seen on multiple sources and with labels nearby
  candidates.sort((a, b) => {
    if (b.sourceCount !== a.sourceCount) return b.sourceCount - a.sourceCount;
    if (b.hasLabel !== a.hasLabel) return (b.hasLabel ? 1 : 0) - (a.hasLabel ? 1 : 0);
    return a.code.localeCompare(b.code);
  });
  return candidates.slice(0, 24);
}

async function chooseBarcodeWithGemini({ locale, productSnapshot, candidates, searchTrace }) {
  const client = await getGeminiClient();
  const modelName = resolveModel(null, 'BARCODE_FIX_MODEL', 'gemini-2.5-flash');
  const model = client.getGenerativeModel({ model: modelName });

  const allowed = new Set(candidates.map((c) => c.code));
  const prompt = [
    'Du bist ein Produktdaten-Assistent für eBay.de.',
    buildCommonPolicyText({ locale, allowWebEvidence: true }),
    '',
    'AUFGABE:',
    '- Wähle GENAU EINEN Barcode (EAN/GTIN/UPC) aus der Kandidatenliste ODER gib "" zurück, wenn nicht eindeutig.',
    '- Du darfst KEINE Barcodes erfinden.',
    '- Wichtig: Die Kandidatenliste enthält NUR Codes, die bereits die GTIN/UPC Checkdigit-Validierung bestehen.',
    '- Entscheide NICHT anhand eigener Checkdigit-Rechnung, sondern anhand der Zuordnung zum Produkt in der WEB-EVIDENZ.',
    '- Nutze nur die WEB-EVIDENZ unten. Wenn du den Code nicht klar dem Produkt zuordnen kannst: "".',
    '',
    'PRODUKT:',
    JSON.stringify(productSnapshot, null, 2),
    '',
    'WEB-SUCHE (Trace):',
    JSON.stringify(searchTrace, null, 2),
    '',
    'KANDIDATEN (du MUSST aus dieser Liste wählen oder leer lassen):',
    JSON.stringify(candidates, null, 2),
  ].join('\n');

  const generationConfig = {
    temperature: 0.1,
    topP: 0.9,
    topK: 64,
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'object',
      required: ['barcode', 'rationale', 'sources'],
      properties: {
        barcode: { type: 'string' },
        rationale: { type: 'string' },
        sources: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    },
  };

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
  });
  const json = JSON.parse(result.response.text());
  const barcode = safeString(json?.barcode);
  const rationale = safeString(json?.rationale);
  const sources = Array.isArray(json?.sources) ? json.sources.map((s) => safeString(s)).filter(Boolean) : [];

  if (!barcode) return { barcode: '', rationale: rationale || 'empty', sources };
  if (!allowed.has(barcode)) {
    return { barcode: '', rationale: `invalid_choice:${barcode}`, sources };
  }
  return { barcode, rationale, sources };
}

function buildProductSnapshot(product) {
  const attrs = product?.details?.attributes && typeof product.details.attributes === 'object' ? product.details.attributes : {};
  const ids = product?.details?.identifiers || {};
  return {
    sku: safeString(product?.identification?.sku) || safeString(ids.sku) || safeString(product?.id),
    title: safeString(product?.identification?.name),
    brand: safeString(product?.identification?.brand),
    category: safeString(product?.identification?.category),
    categoryId: safeString(product?.details?.categoryId),
    mpn: safeString(ids.mpn) || safeString(attrs.Herstellernummer),
    model: safeString(attrs.Modell || attrs.Model || ''),
    produktart: safeString(attrs.Produktart || attrs.Produkttyp || ''),
  };
}

function applyBarcodeToProduct(product, barcode) {
  const next = JSON.parse(JSON.stringify(product));
  if (!next.identification) next.identification = {};
  if (!next.details) next.details = {};
  if (!next.details.identifiers) next.details.identifiers = {};
  if (!next.ops) next.ops = {};

  const codes = Array.isArray(next.identification.barcodes) ? next.identification.barcodes : [];
  const normalizedExisting = new Set(codes.map((c) => normalizeDigits(String(c))));
  const normalized = normalizeDigits(barcode);
  const nextBarcodes = [normalized, ...codes.map((c) => normalizeDigits(String(c)))].filter(Boolean);
  // de-dupe while preserving order
  const out = [];
  const seen = new Set();
  for (const c of nextBarcodes) {
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
    if (out.length >= 6) break;
  }
  next.identification.barcodes = out;

  const t = getGtinType(normalized);
  if (t === 'ean13' && !safeString(next.details.identifiers.ean)) next.details.identifiers.ean = normalized;
  if (t === 'gtin14' && !safeString(next.details.identifiers.gtin)) next.details.identifiers.gtin = normalized;
  if (t === 'upc12' && !safeString(next.details.identifiers.upc)) next.details.identifiers.upc = normalized;

  next.ops.data_quality = {
    ...(next.ops.data_quality || {}),
    barcode_backfilled_web_v1: {
      at_iso: new Date().toISOString(),
      value: normalized,
      hadExisting: normalizedExisting.has(normalized),
    },
  };

  return next;
}

function parseArgs(argv) {
  const args = {
    apply: false,
    dryRun: true,
    expectedCount: 420,
    concurrency: 2,
    limit: 0,
    locale: 'de-DE',
    maxSearchResults: 6,
    maxPages: 4,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--apply') { args.apply = true; args.dryRun = false; }
    else if (t === '--dry-run') { args.apply = false; args.dryRun = true; }
    else if (t === '--expected-count') { args.expectedCount = Number(argv[i + 1]); i += 1; }
    else if (t === '--concurrency') { args.concurrency = Number(argv[i + 1]); i += 1; }
    else if (t === '--limit') { args.limit = Number(argv[i + 1]); i += 1; }
    else if (t === '--locale') { args.locale = argv[i + 1]; i += 1; }
    else if (t === '--max-search-results') { args.maxSearchResults = Number(argv[i + 1]); i += 1; }
    else if (t === '--max-pages') { args.maxPages = Number(argv[i + 1]); i += 1; }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'barcode-backfill-web', stamp);
  ensureDir(outDir);

  console.log(`[barcode-backfill-web] mode=${args.apply ? 'APPLY' : 'DRY_RUN'} out=${outDir} unlocker=${USE_UNLOCKER}`);

  const products = await getAllProducts();
  const preCount = products.length;
  console.log(`[barcode-backfill-web] preCount=${preCount}`);
  if (args.apply && preCount !== args.expectedCount) {
    throw new Error(`[barcode-backfill-web] ABORT: expected preCount=${args.expectedCount} but got ${preCount}`);
  }

  const targets = products.filter((p) => !hasAnyValidBarcode(p));
  const limited = args.limit > 0 ? targets.slice(0, args.limit) : targets;
  console.log(`[barcode-backfill-web] targets=${targets.length} processing=${limited.length}`);

  const queue = new PQueue({ concurrency: Math.max(1, args.concurrency || 2) });
  const report = [];
  let wouldApply = 0;
  let applied = 0;
  let skipped = 0;
  let failed = 0;

  for (const p of limited) {
    queue.add(async () => {
      const productId = safeString(p?.id);
      const product = productId ? await getProduct(productId) : p;
      if (!product?.id) {
        failed += 1;
        report.push({ productId, status: 'failed', reason: 'product_not_found' });
        return;
      }
      if (hasAnyValidBarcode(product)) {
        skipped += 1;
        report.push({ productId, sku: pickQuery(product), status: 'skip', reason: 'already_has_barcode' });
        return;
      }

      const query = pickQuery(product);
      const trace = [];
      // Explicit search attempts for diagnostics + stability.
      const ddgAttempt = await searchDuckDuckGo(query, { limit: Math.max(1, args.maxSearchResults || 6) });
      trace.push({
        type: 'ddg_attempt',
        ok: ddgAttempt.ok,
        status: ddgAttempt.status,
        resultsCount: Array.isArray(ddgAttempt.results) ? ddgAttempt.results.length : 0,
        url: ddgAttempt.url,
        via: ddgAttempt.via,
        results: (ddgAttempt.results || []).slice(0, 5),
      });
      const googleAttempt = await searchGoogle(query, { limit: Math.max(1, args.maxSearchResults || 6) });
      trace.push({
        type: 'google_attempt',
        ok: googleAttempt.ok,
        status: googleAttempt.status,
        resultsCount: Array.isArray(googleAttempt.results) ? googleAttempt.results.length : 0,
        url: googleAttempt.url,
        via: googleAttempt.via,
        results: (googleAttempt.results || []).slice(0, 5),
      });

      const search =
        (ddgAttempt && ddgAttempt.ok && Array.isArray(ddgAttempt.results) && ddgAttempt.results.length)
          ? ddgAttempt
          : googleAttempt;

      const urls = (search.results || []).map((r) => r.url).filter(Boolean).slice(0, Math.max(1, args.maxPages || 4));
      const pages = [];
      for (const url of urls) {
        const fetched = await fetchText(url);
        const body = fetched.body || '';
        const text = htmlToText(body);
        pages.push({ url, ok: fetched.ok, status: fetched.status, via: fetched.via, text });
      }

      const snapshot = buildProductSnapshot(product);
      const anchorTokens = buildAnchorTokens(snapshot);
      const candidates = buildCandidateIndex(pages, { anchorTokens });
      if (!candidates.length) {
        skipped += 1;
        report.push({ productId, sku: safeString(product?.identification?.sku), status: 'skip', reason: 'no_valid_candidates', query, trace });
        return;
      }

      // Fast path: exactly one candidate and it has strong evidence → accept without LLM.
      if (candidates.length === 1) {
        const only = candidates[0];
        const strongAnchors = Array.isArray(anchorTokens?.strong) ? anchorTokens.strong : [];
        const contextText = (only?.sources || [])
          .flatMap((s) => (Array.isArray(s?.contexts) ? s.contexts : []))
          .join(' ')
          .toLowerCase();
        const hasStrongInContext = strongAnchors.length
          ? strongAnchors.some((tok) => tok && contextText.includes(tok))
          : true;
        const strong = (Boolean(only?.hasLabel) || Number(only?.sourceCount || 0) >= 2) && hasStrongInContext;
        if (strong) {
          if (!args.apply) {
            wouldApply += 1;
            report.push({ productId, sku: snapshot.sku, status: 'would_apply', query, chosen: only.code, candidate: only, choice: { barcode: only.code, rationale: 'fast_path_single_candidate', sources: only.sources?.map((s) => s.url).filter(Boolean) || [] } });
            return;
          }
          const next = applyBarcodeToProduct(product, only.code);
          await saveProduct(next, { source: 'barcode-web', syncIdentifiersFromBarcodes: false });
          applied += 1;
          report.push({ productId, sku: snapshot.sku, status: 'applied', query, chosen: only.code, candidate: only, choice: { barcode: only.code, rationale: 'fast_path_single_candidate', sources: only.sources?.map((s) => s.url).filter(Boolean) || [] } });
          return;
        }
      }

      const choice = await chooseBarcodeWithGemini({
        locale: args.locale,
        productSnapshot: snapshot,
        candidates,
        searchTrace: {
          query,
          pages: pages.map((pg) => ({ url: pg.url, ok: pg.ok, status: pg.status, via: pg.via })),
        },
      });

      const chosen = normalizeDigits(choice.barcode || '');
      if (!chosen || !isValidGtin(chosen)) {
        skipped += 1;
        report.push({
          productId,
          sku: snapshot.sku,
          status: 'skip',
          reason: 'llm_no_choice',
          query,
          candidates,
          choice,
        });
        return;
      }

      // Extra guard: require label context OR 2+ sources.
      const cand = candidates.find((c) => c.code === chosen);
      const strongAnchors = Array.isArray(anchorTokens?.strong) ? anchorTokens.strong : [];
      const contextText = (cand?.sources || [])
        .flatMap((s) => (Array.isArray(s?.contexts) ? s.contexts : []))
        .join(' ')
        .toLowerCase();
      const hasStrongInContext = strongAnchors.length
        ? strongAnchors.some((tok) => tok && contextText.includes(tok))
        : true; // if we have no strong anchors, don't block on it
      const okEvidence = (Boolean(cand?.hasLabel) || Number(cand?.sourceCount || 0) >= 2) && hasStrongInContext;
      if (!okEvidence) {
        skipped += 1;
        report.push({
          productId,
          sku: snapshot.sku,
          status: 'skip',
          reason: strongAnchors.length && !hasStrongInContext ? 'insufficient_anchor_match' : 'insufficient_evidence',
          query,
          chosen,
          candidate: cand,
          choice,
        });
        return;
      }

      if (!args.apply) {
        wouldApply += 1;
        report.push({
          productId,
          sku: snapshot.sku,
          status: 'would_apply',
          query,
          chosen,
          candidate: cand,
          choice,
        });
        return;
      }

      const next = applyBarcodeToProduct(product, chosen);
      // IMPORTANT: never auto-populate identifiers from web-derived barcodes (avoid poisoning).
      await saveProduct(next, { source: 'barcode-web', syncIdentifiersFromBarcodes: false });
      applied += 1;
      report.push({
        productId,
        sku: snapshot.sku,
        status: 'applied',
        query,
        chosen,
        candidate: cand,
        choice,
      });
    });
  }

  await queue.onIdle();

  const summary = {
    preCount,
    targets: targets.length,
    processed: limited.length,
    applied,
    wouldApply,
    skipped,
    failed,
    outDir,
  };
  fs.writeFileSync(path.join(outDir, args.apply ? 'apply_summary.json' : 'dryrun_summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, args.apply ? 'apply_report.json' : 'dryrun_report.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log(`[barcode-backfill-web] applied=${applied} wouldApply=${wouldApply} skipped=${skipped} failed=${failed}`);

  if (args.apply) {
    const post = await getAllProducts();
    const postCount = post.length;
    if (postCount !== preCount) {
      throw new Error(`[barcode-backfill-web] COUNT MISMATCH pre=${preCount} post=${postCount}`);
    }
    console.log(`[barcode-backfill-web] postCount=${postCount} (ok)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


