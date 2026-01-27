/* eslint-disable no-console */
/**
 * GPSR enrichment via Web evidence + Gemini (server-side).
 *
 * What this does:
 * - For products missing GPSR fields (or still having placeholders), it searches the web
 *   using DuckDuckGo HTML results (best-effort; not an official API), fetches top pages,
 *   and asks Gemini to extract GPSR fields ONLY from that evidence.
 * - Saves the product back via saveProduct() so our central GPSR normalization kicks in:
 *   - street-only address splitting
 *   - English country name normalization
 *   - placeholders if still missing
 *
 * IMPORTANT:
 * - This script does not invent data. Gemini must base its output on provided evidence.
 * - If evidence is insufficient, fields remain empty and placeholders will be used by saveProduct().
 *
 * Usage:
 *   node backend/scripts/gpsr-enrich-with-web.js --dry-run --limit 20
 *   node backend/scripts/gpsr-enrich-with-web.js --apply --limit 200 --concurrency 2
 *
 * Env:
 *   GPSR_WEB_USE_UNLOCKER=true  (optional; uses BrightData Web Unlocker if configured)
 *   GEMINI_STRUCTURED_MODEL=gemini-2.5-flash (optional)
 */

const fs = require('fs');
const path = require('path');
const fetch = global.fetch || require('node-fetch');
const PQueue = require('p-queue').default || require('p-queue');
const { getAllProducts, getProduct, saveProduct } = require('../lib/firestore');
const { callGeminiStructured } = require('../lib/gemini-structured');
const { fetchWithUnlocker } = require('../lib/web-unlocker');
const { buildCommonPolicyText } = require('../lib/llm-policy-pack');

const USE_UNLOCKER = (process.env.GPSR_WEB_USE_UNLOCKER || '').toString().toLowerCase() === 'true';

function argFlag(name) {
  return process.argv.includes(name);
}
function argValue(name, fallback = null) {
  const idx = process.argv.findIndex((x) => x === name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

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
  return normalizeSpaces(decodeHtmlEntities(cleaned)).slice(0, 200_000);
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
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const href = m[1];
    const title = normalizeSpaces(decodeHtmlEntities(m[2].replace(/<[^>]+>/g, ' ')));
    let outUrl = href;
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
    results.push({ url: outUrl, title });
    if (results.length >= limit) break;
  }
  return { query, ok: true, url, via: res.via, status: res.status, results };
}

function pickQuery(product) {
  const name = safeString(product?.identification?.name);
  const brand = safeString(product?.identification?.brand);
  const ids = product?.details?.identifiers || {};
  const ean = safeString(ids.ean || ids.gtin || ids.upc);
  const manufacturer = safeString(product?.details?.gpsr?.manufacturer_name) || brand;
  const tokens = [name, ean, manufacturer].filter(Boolean).join(' ');
  return normalizeSpaces(`${tokens} GPSR Hersteller Adresse E-Mail Telefon`);
}

function isPlaceholderValue(val) {
  const v = safeString(val).toLowerCase();
  if (!v) return false;
  return (
    v.includes('musterstraße') ||
    v.includes('muster str') ||
    v.includes('musterstadt') ||
    v.includes('musterbundesland') ||
    v === '12345' ||
    v.includes('info@muster') ||
    v.includes('+49 000') ||
    v === 'germany'
  );
}

function needsGpsr(product) {
  const g = product?.details?.gpsr || {};
  const fields = [
    'entity_country',
    'manufacturer_city',
    'manufacturer_address',
    'manufacturer_name',
    'email',
    'manufacturer_phone',
    'manufacturer_state_province',
    'manufacturer_postalcode',
  ];
  for (const f of fields) {
    const v = safeString(g[f]);
    if (!v || isPlaceholderValue(v)) return true;
  }
  return false;
}

function sumStorageBins(product) {
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  return bins.reduce((sum, b) => sum + (Number(b?.quantity) || 0), 0);
}

function hasBin(product) {
  const explicit = safeString(product?.storage?.binCode);
  if (explicit) return true;
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  return bins.some((b) => safeString(b?.code || b?.binCode) && (Number(b?.quantity) || 0) > 0);
}

function pickQuantity(product) {
  const invQty = product?.inventory?.quantity;
  if (typeof invQty === 'number' && Number.isFinite(invQty) && invQty >= 0) return invQty;
  return sumStorageBins(product);
}

function pickPriceAmount(product) {
  const lowest = product?.details?.pricing?.lowest_price;
  const amount = lowest?.amount;
  if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) return amount;
  const legacy = product?.details?.pricing?.price;
  if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy >= 0) return legacy;
  return 0;
}

const GPSR_SCHEMA = {
  type: 'object',
  properties: {
    entity_country: { type: 'string' },
    manufacturer_name: { type: 'string' },
    manufacturer_address: { type: 'string' },
    manufacturer_city: { type: 'string' },
    manufacturer_postalcode: { type: 'string' },
    manufacturer_state_province: { type: 'string' },
    manufacturer_email: { type: 'string' },
    manufacturer_phone: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: ['entity_country', 'manufacturer_name', 'manufacturer_address', 'manufacturer_city', 'manufacturer_postalcode', 'manufacturer_state_province', 'manufacturer_email', 'manufacturer_phone', 'sources', 'confidence'],
};

function buildPrompt({ product, evidenceBlocks, urls }) {
  const name = safeString(product?.identification?.name);
  const brand = safeString(product?.identification?.brand);
  const ids = product?.details?.identifiers || {};
  const ean = safeString(ids.ean || ids.gtin || ids.upc);

  const policy = buildCommonPolicyText({ mode: 'gpsr' });
  return normalizeSpaces(`
${policy}

TASK:
Extract GPSR manufacturer/contact data for the product below using ONLY the provided WEB EVIDENCE.
If a value is not clearly supported by evidence, return an empty string for that field.
Do NOT refuse. Do NOT complain. Do NOT mention policy. Just return JSON matching the schema.

Product:
- Item Name: ${name || '—'}
- EAN/GTIN: ${ean || '—'}
- Brand/Manufacturer hint: ${brand || '—'}

Fields to extract:
- entity_country (English country name, e.g. "Germany", not "DE")
- manufacturer_name
- manufacturer_address (street + house number only; no postal code/city/country)
- manufacturer_city
- manufacturer_postalcode
- manufacturer_state_province
- manufacturer_email (support email ok)
- manufacturer_phone (support hotline ok)

Sources:
You MUST output "sources" as the subset of URLs you used from this list:
${urls.map((u) => `- ${u}`).join('\n')}

WEB EVIDENCE (snippets, may be partial):
${evidenceBlocks.join('\n\n---\n\n').slice(0, 120_000)}
  `).trim();
}

async function enrichOne(product, { dryRun, debugDir }) {
  const productId = product?.id;
  if (!productId) return { ok: false, reason: 'missing_id' };
  if (!needsGpsr(product)) return { ok: false, reason: 'already_ok' };

  const query = pickQuery(product);
  const search = await searchDuckDuckGo(query, { limit: 6 });
  const urls = (search.results || []).map((r) => r.url).filter(Boolean).slice(0, 5);
  if (!urls.length) return { ok: false, reason: 'no_search_results', query };

  const pages = [];
  for (const url of urls) {
    const res = await fetchText(url);
    if (!res.ok || !res.body) continue;
    pages.push({ url, via: res.via, status: res.status, text: htmlToText(res.body) });
  }
  if (!pages.length) return { ok: false, reason: 'no_pages_fetched', query, urls };

  const evidenceBlocks = pages.map((p) => `URL: ${p.url}\n${p.text.slice(0, 25_000)}`);
  const prompt = buildPrompt({ product, evidenceBlocks, urls });

  if (debugDir) {
    ensureDir(debugDir);
    const outPath = path.join(debugDir, `${String(productId).replace(/[^a-z0-9_-]/gi, '_')}.txt`);
    fs.writeFileSync(outPath, prompt.slice(0, 200_000), 'utf8');
  }

  const jsonText = await callGeminiStructured({
    parts: [{ text: prompt }],
    responseSchema: GPSR_SCHEMA,
    temperature: 0.0,
    maxOutputTokens: 1024,
  });

  let parsed = null;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    return { ok: false, reason: 'json_parse_failed', error: e.message, raw: jsonText.slice(0, 800) };
  }

  const extracted = {
    entity_country: safeString(parsed.entity_country),
    manufacturer_name: safeString(parsed.manufacturer_name),
    manufacturer_address: safeString(parsed.manufacturer_address),
    manufacturer_city: safeString(parsed.manufacturer_city),
    manufacturer_postalcode: safeString(parsed.manufacturer_postalcode),
    manufacturer_state_province: safeString(parsed.manufacturer_state_province),
    email: safeString(parsed.manufacturer_email),
    manufacturer_phone: safeString(parsed.manufacturer_phone),
  };

  // Merge into existing gpsr without dropping existing real values.
  const existingGpsr = product?.details?.gpsr && typeof product.details.gpsr === 'object' ? { ...product.details.gpsr } : {};
  const mergedGpsr = { ...existingGpsr };
  for (const [k, v] of Object.entries(extracted)) {
    if (!v) continue;
    const current = safeString(existingGpsr[k]);
    if (!current || isPlaceholderValue(current)) {
      mergedGpsr[k] = v;
    }
  }

  const next = {
    ...product,
    details: {
      ...(product.details || {}),
      gpsr: mergedGpsr,
    },
    ops: {
      ...(product.ops || {}),
      data_quality: {
        ...((product.ops || {}).data_quality || {}),
        gpsr_web_enrich_v1: {
          at_iso: new Date().toISOString(),
          query,
          sources: Array.isArray(parsed.sources) ? parsed.sources.slice(0, 8) : urls.slice(0, 8),
          confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
        },
      },
    },
  };

  if (!dryRun) {
    await saveProduct(next, { source: 'script', skipTitlePolicy: true, skipKeyFeaturesNormalize: true });
  }

  return { ok: true, productId, query, updated: !dryRun, sources: urls.slice(0, 5) };
}

async function main() {
  const apply = argFlag('--apply');
  const dryRun = !apply;
  const limit = Math.max(1, parseInt(argValue('--limit', '200') || '200', 10));
  const concurrency = Math.max(1, parseInt(argValue('--concurrency', '2') || '2', 10));
  const debug = argFlag('--debug');
  const minQty = Math.max(1, parseInt(argValue('--min-qty', '1') || '1', 10));
  const minPrice = Math.max(0, parseFloat(argValue('--min-price', '50') || '50'));

  const debugDir = debug ? path.resolve(`backend/exports/gpsr-web-enrich/${nowStamp()}`) : null;
  if (debugDir) ensureDir(debugDir);

  console.log(JSON.stringify({ action: 'gpsr-web-enrich', dryRun, limit, concurrency, debugDir, minQty, minPrice }, null, 2));

  const all = await getAllProducts();
  const candidates = Array.isArray(all)
    ? all
        .filter((p) => p?.id)
        .filter((p) => hasBin(p))
        .filter((p) => pickQuantity(p) >= minQty)
        .filter((p) => pickPriceAmount(p) > minPrice)
        .filter((p) => needsGpsr(p))
        .slice(0, limit)
    : [];
  console.log(
    JSON.stringify(
      { totalProducts: all?.length || 0, candidates: candidates.length, filter: { hasBin: true, minQty, minPrice } },
      null,
      2
    )
  );

  const queue = new PQueue({ concurrency });
  let ok = 0;
  let failed = 0;
  const reasons = {};

  await Promise.all(
    candidates.map((p) =>
      queue.add(async () => {
        try {
          const fresh = await getProduct(p.id);
          const res = await enrichOne(fresh || p, { dryRun, debugDir });
          if (res.ok) {
            ok += 1;
          } else {
            failed += 1;
            const r = res.reason || 'unknown';
            reasons[r] = (reasons[r] || 0) + 1;
          }
          if ((ok + failed) % 10 === 0) {
            console.log(JSON.stringify({ progress: ok + failed, ok, failed, reasons }, null, 2));
          }
        } catch (e) {
          failed += 1;
          reasons.exception = (reasons.exception || 0) + 1;
          console.warn('gpsr enrich failed:', e?.message || e);
        }
      })
    )
  );

  console.log(JSON.stringify({ done: true, ok, failed, reasons }, null, 2));
  if (!dryRun && failed > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

