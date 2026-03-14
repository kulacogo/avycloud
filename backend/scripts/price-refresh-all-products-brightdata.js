/* eslint-disable no-console */
/**
 * Bulk price check + refresh (BrightData only).
 *
 * Strategy:
 * - For each product, validate existing lowest_price (amount>0, EUR, sources, last_checked_iso).
 * - If missing/invalid/old (default >14d) or sources empty, we refresh via BrightData:
 *   marketplace-first site searches (ebay.de/kaufland.de/hood.de) -> broad web search fallback
 *   then fetch 1-2 pages and extract EUR prices from meta/JSON-LD/regex.
 *
 * Safety:
 * - Updates Firestore via doc.update() with dot-paths (does NOT overwrite the full product).
 * - Never writes amount=0 as a "placeholder".
 *
 * Usage:
 *   NODE_PATH=backend/node_modules GOOGLE_CLOUD_PROJECT=avycloud WEB_BRIGHTDATA_ONLY=true \
 *   node backend/scripts/price-refresh-all-products-brightdata.js --concurrency 8 --max-age-days 14
 *
 * Optional:
 *   --limit <n> --offset <n> --only-missing (only amount<=0)
 */

const crypto = require('crypto');
const PQueue = require('p-queue').default;
const { firestore, getAllProducts } = require('../lib/firestore');
const { search, searchSite } = require('../lib/evidence-provider');
const { fetchWithUnlocker } = require('../lib/web-unlocker');

const MARKETPLACE_SITES = ['ebay.de', 'kaufland.de', 'hood.de'];
const USED_HINT = /\b(gebraucht|used|refurb|refurbished|renewed|b-ware|pre-owned|second hand|open box)\b/i;

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function nowIso() {
  return new Date().toISOString();
}

function daysSince(iso) {
  if (!iso) return Infinity;
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
}

function pickSku(product) {
  return (
    safeString(product?.identification?.sku) ||
    safeString(product?.details?.identifiers?.sku) ||
    safeString(product?.id) ||
    ''
  );
}

function pickBarcode(product) {
  const list = []
    .concat(Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [])
    .concat([
      product?.details?.identifiers?.ean,
      product?.details?.identifiers?.gtin,
      product?.details?.identifiers?.upc,
    ])
    .filter(Boolean)
    .map((x) => safeString(x))
    .filter((x) => x.length >= 8);
  return list[0] || '';
}

function pickBrand(product) {
  return safeString(product?.identification?.brand) || safeString(product?.details?.brand) || '';
}

function pickTitle(product) {
  return safeString(product?.identification?.name) || '';
}

function pickMpn(product) {
  const attrs = product?.details?.attributes && typeof product.details.attributes === 'object' ? product.details.attributes : {};
  return (
    safeString(product?.details?.identifiers?.mpn) ||
    safeString(attrs?.Herstellernummer) ||
    safeString(attrs?.MPN) ||
    safeString(attrs?.mpn) ||
    ''
  );
}

function parseEurAmount(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // normalize thousand separators: 1.234,56 -> 1234.56
  const cleaned = s
    .replace(/\s+/g, '')
    .replace(/€/g, '')
    .replace(/EUR/gi, '')
    .replace(/\.(?=\d{3}(\D|$))/g, '') // remove thousand dots
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
  while ((m = re.exec(html))) {
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
    // try to strip trailing commas
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

    // schema.org Product offers price
    const offers = node.offers;
    if (offers) visit(offers);
    const price = node.price;
    const currency = node.priceCurrency || node.pricecurrency;
    if (price != null) {
      const amount = parseEurAmount(price);
      const cur = safeString(currency).toUpperCase();
      if (amount != null && (!cur || cur === 'EUR')) {
        out.push(amount);
      }
    }
    // Some sites nest under @graph
    if (node['@graph']) visit(node['@graph']);
    // Walk children
    for (const v of Object.values(node)) {
      visit(v);
    }
  };
  visit(obj);
  return out;
}

function extractPriceCandidates(html) {
  const candidates = [];

  // OpenGraph/Product meta
  const metaAmount =
    html.match(/property=["']?product:price:amount["']?[^>]*content=["']?([\d.,]+)/i)?.[1] ||
    html.match(/itemprop=["']?price["']?[^>]*content=["']?([\d.,]+)/i)?.[1] ||
    html.match(/itemprop=["']?price["']?[^>]*content=["']?(\d+(?:[.,]\d{2})?)/i)?.[1];
  const metaCurrency =
    html.match(/property=["']?product:price:currency["']?[^>]*content=["']?([A-Z]{3})/i)?.[1] ||
    html.match(/itemprop=["']?priceCurrency["']?[^>]*content=["']?([A-Z]{3})/i)?.[1];
  if (metaAmount) {
    const amount = parseEurAmount(metaAmount);
    const cur = safeString(metaCurrency).toUpperCase();
    if (amount != null && (!cur || cur === 'EUR')) {
      candidates.push(amount);
    }
  }

  // JSON-LD
  for (const block of extractJsonLdBlocks(html)) {
    const parsed = tryParseJsonLenient(block);
    if (!parsed) continue;
    const prices = collectPricesFromJsonLd(parsed);
    prices.forEach((p) => candidates.push(p));
  }

  // Generic EUR pattern (fallback)
  const re = /(?:EUR\s*)?(\d{1,5}(?:[.,]\d{2}))\s*€/gi;
  let m;
  while ((m = re.exec(html))) {
    const amount = parseEurAmount(m[1]);
    if (amount != null) candidates.push(amount);
    if (candidates.length >= 20) break;
  }

  // de format without euro sign but with "EUR"
  const re2 = /EUR\s*(\d{1,5}(?:[.,]\d{2}))/gi;
  while ((m = re2.exec(html))) {
    const amount = parseEurAmount(m[1]);
    if (amount != null) candidates.push(amount);
    if (candidates.length >= 20) break;
  }

  // dedupe
  return Array.from(new Set(candidates)).sort((a, b) => a - b);
}

async function fetchHtml(url) {
  const result = await fetchWithUnlocker({
    url,
    method: 'GET',
    format: 'raw',
    timeoutMs: 35_000,
    headers: {
      'User-Agent': 'avystock-price-refresh/2.0',
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'de-DE,de;q=0.9,en;q=0.7',
    },
  });
  if (!result?.success) {
    throw new Error(result?.error || result?.statusText || 'unlocker_failed');
  }
  return String(result.body || '');
}

async function findPriceForProduct(product) {
  const brand = pickBrand(product);
  const title = pickTitle(product);
  const mpn = pickMpn(product);
  const barcode = pickBarcode(product);
  const sku = pickSku(product);

  // Build short, high-signal queries (fast + fewer false positives)
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

  // Marketplace-first
  for (const q of queries.slice(0, 3)) {
    for (const site of MARKETPLACE_SITES) {
      const res = await searchSite(q, site, { limit: 4, locale: 'de-DE' });
      tried.push({ q, site, ok: res.ok, error: res.error || null });
      if (res.ok && Array.isArray(res.results) && res.results.length) {
        results = res.results;
        usedQuery = `${q} site:${site}`;
        usedEngine = res.engine;
        break;
      }
    }
    if (results.length) break;
  }

  // Broad fallback
  if (!results.length) {
    for (const q of queries.slice(0, 3)) {
      const res = await search(q, { limit: 6, locale: 'de-DE' });
      tried.push({ q, site: null, ok: res.ok, error: res.error || null });
      if (res.ok && Array.isArray(res.results) && res.results.length) {
        results = res.results;
        usedQuery = q;
        usedEngine = res.engine;
        break;
      }
    }
  }

  const urls = (results || [])
    .map((r) => safeString(r?.url))
    .filter((u) => u.startsWith('http'))
    .slice(0, 3);

  const sourceCandidates = [];
  for (const url of urls) {
    try {
      const html = await fetchHtml(url);
      // Best-effort new-only gate (reduces "used" / refurb / B-ware false positives).
      const pageTitle = html.match(/<title[^>]*>([^<]{3,200})<\/title>/i)?.[1] || '';
      const textBlob = `${pageTitle} ${html.slice(0, 4000)}`;
      if (USED_HINT.test(textBlob)) continue;
      const prices = extractPriceCandidates(html);
      if (prices.length) {
        sourceCandidates.push({ url, prices });
      }
    } catch {
      // ignore fetch failures
    }
  }

  if (!sourceCandidates.length) {
    return {
      ok: false,
      reason: 'no_price_found',
      usedQuery,
      usedEngine,
      tried,
      candidates: [],
    };
  }

  const median = (values = []) => {
    const nums = values
      .filter((n) => typeof n === 'number' && Number.isFinite(n))
      .sort((a, b) => a - b);
    if (!nums.length) return null;
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  };

  // Pick a robust market midpoint (avoid selecting the single cheapest outlier).
  const perSource = sourceCandidates
    .map((c) => {
      const prices = (Array.isArray(c.prices) ? c.prices : [])
        .filter((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0.5 && n <= 50000)
        .sort((a, b) => a - b);
      const representative = median(prices) ?? prices[0] ?? null;
      return { url: c.url, amount: representative };
    })
    .filter((x) => typeof x.amount === 'number' && Number.isFinite(x.amount));

  if (!perSource.length) {
    return {
      ok: false,
      reason: 'no_price_found',
      usedQuery,
      usedEngine,
      tried,
      candidates: [],
    };
  }

  const target = median(perSource.map((x) => x.amount));
  const best =
    typeof target === 'number' && Number.isFinite(target)
      ? perSource
          .slice()
          .sort((a, b) => Math.abs(a.amount - target) - Math.abs(b.amount - target) || a.amount - b.amount)[0]
      : perSource.slice().sort((a, b) => a.amount - b.amount)[0];

  const sources = perSource.slice(0, 3).map((c) => ({
    name: (() => {
      try {
        return new URL(c.url).host;
      } catch {
        return 'web';
      }
    })(),
    url: c.url,
    price: c.amount || null,
    shipping: null,
    checked_at: nowIso(),
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

function shouldRefresh(product, { maxAgeDays, onlyMissing, force }) {
  const lp = product?.details?.pricing?.lowest_price;
  const amount = lp?.amount;
  const okAmount = typeof amount === 'number' && Number.isFinite(amount) && amount > 0;
  if (onlyMissing) return !okAmount;
  const age = daysSince(lp?.last_checked_iso);
  const sources = Array.isArray(lp?.sources) ? lp.sources : [];
  const sourcesOk = sources.length > 0;
  const currencyOk = safeString(lp?.currency).toUpperCase() === 'EUR' || !safeString(lp?.currency);
  const plausible = okAmount && amount >= 0.5 && amount <= 50000;
  const trustedOrigin = sources.some((s) => {
    const url = safeString(s?.url).toLowerCase();
    return url.startsWith('manual://');
  });
  if (!force && trustedOrigin && plausible && currencyOk) {
    // Never overwrite trusted listing prices from manual edits.
    return false;
  }
  return !okAmount || !plausible || !currencyOk || !sourcesOk || age > maxAgeDays;
}

function parseArgs(argv) {
  const args = {
    concurrency: 8,
    maxAgeDays: 14,
    limit: 0,
    offset: 0,
    onlyMissing: false,
    force: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--concurrency') {
      args.concurrency = Number(argv[i + 1]);
      i += 1;
    }
    if (t === '--max-age-days') {
      args.maxAgeDays = Number(argv[i + 1]);
      i += 1;
    }
    if (t === '--limit') {
      args.limit = Number(argv[i + 1]);
      i += 1;
    }
    if (t === '--offset' || t === '--skip') {
      args.offset = Number(argv[i + 1]);
      i += 1;
    }
    if (t === '--only-missing') {
      args.onlyMissing = true;
    }
    if (t === '--force') {
      args.force = true;
    }
  }
  args.concurrency = Number.isFinite(args.concurrency) ? Math.max(1, Math.floor(args.concurrency)) : 8;
  args.maxAgeDays = Number.isFinite(args.maxAgeDays) ? Math.max(1, args.maxAgeDays) : 14;
  args.limit = Number.isFinite(args.limit) ? Math.max(0, Math.floor(args.limit)) : 0;
  args.offset = Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0;
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(JSON.stringify({ action: 'price-refresh', ...args, at: nowIso() }, null, 2));

  const all = await getAllProducts();
  const list = (Array.isArray(all) ? all : []).filter((p) => p?.id);

  const targets = list.filter((p) =>
    shouldRefresh(p, { maxAgeDays: args.maxAgeDays, onlyMissing: args.onlyMissing, force: args.force })
  );
  targets.sort((a, b) => pickSku(a).localeCompare(pickSku(b), 'de', { sensitivity: 'base' }));

  const offsetList = args.offset ? targets.slice(args.offset) : targets;
  const selected = args.limit && args.limit > 0 ? offsetList.slice(0, args.limit) : offsetList;

  console.log(JSON.stringify({ total: list.length, targets: targets.length, selected: selected.length }, null, 2));

  const queue = new PQueue({ concurrency: args.concurrency });
  let done = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  const runOne = async (product, idx) => {
    const productId = product.id;
    const sku = pickSku(product);
    const lp = product?.details?.pricing?.lowest_price || {};
    const before = {
      amount: typeof lp.amount === 'number' ? lp.amount : null,
      currency: safeString(lp.currency) || null,
      last_checked_iso: safeString(lp.last_checked_iso) || null,
      sources: Array.isArray(lp.sources) ? lp.sources.length : 0,
    };

    const traceId = crypto.randomUUID();
    try {
      const res = await findPriceForProduct(product);
      if (!res.ok) {
        skipped += 1;
        done += 1;
        if (done % 25 === 0 || done === selected.length) {
          console.log(JSON.stringify({ done, updated, skipped, failed, last: { sku, productId, status: 'no_price' } }, null, 2));
        }
        return;
      }

      const updateData = {
        'details.pricing.lowest_price.amount': res.amount,
        'details.pricing.lowest_price.currency': 'EUR',
        'details.pricing.lowest_price.sources': res.sources,
        'details.pricing.lowest_price.last_checked_iso': nowIso(),
        'details.pricing.price_confidence': 0.7,
        'ops.data_quality.price_refresh_v1': {
          at_iso: nowIso(),
          trace_id: traceId,
          query: res.usedQuery || null,
          engine: res.usedEngine || null,
          sources: (res.sources || []).map((s) => s.url).filter(Boolean).slice(0, 5),
        },
      };

      await firestore.collection('products').doc(productId).update(updateData);
      updated += 1;
      done += 1;

      if (done % 10 === 0 || done === selected.length) {
        console.log(
          JSON.stringify(
            {
              done,
              updated,
              skipped,
              failed,
              last: { sku, productId, before, after: { amount: res.amount, currency: 'EUR', sources: res.sources.length } },
            },
            null,
            2
          )
        );
      }
    } catch (e) {
      failed += 1;
      done += 1;
      console.warn(`[price-refresh] failed sku=${sku} id=${productId}:`, e?.message || e);
    }
  };

  selected.forEach((p, idx) => {
    queue.add(() => runOne(p, idx));
  });

  await queue.onIdle();
  console.log(JSON.stringify({ done: true, selected: selected.length, updated, skipped, failed }, null, 2));
  if (failed > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

