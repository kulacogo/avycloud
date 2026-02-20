/* eslint-disable no-console */
/**
 * Ensure GPSR coverage for all products (backend-side), using manufacturer-level registry.
 *
 * Strategy:
 * 1) Load all products
 * 2) Group by manufacturer (brand/manufacturer_name)
 * 3) Enrich manufacturer registry via web evidence + Gemini (only if confident + sources)
 * 4) Apply best registry record to ALL products of that manufacturer (fill missing, replace placeholder-like)
 * 5) Export a report CSV of remaining missing required fields (for manual follow-up)
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud WEB_USE_UNLOCKER=true node backend/scripts/gpsr-ensure-correct-all-products.js --apply
 *
 * Options:
 *   --dry-run                 (default)
 *   --apply
 *   --manufacturer-limit <n>  limit manufacturers processed (default: 99999)
 *   --concurrency <n>         manufacturer web enrichment concurrency (default: 3, max 6)
 *   --apply-concurrency <n>   product apply concurrency (default: 6, max 12)
 *   --min-confidence <0..1>   (default: 0.6)
 *   --search-limit <n>        (default: 10)
 *   --max-pages <n>           (default: 5)
 *
 * Output:
 *   backend/exports/gpsr-coverage/gpsr-coverage-report-<stamp>.csv
 */

const fs = require('fs');
const path = require('path');
const PQueue = require('p-queue').default || require('p-queue');

const { getAllProducts, getProduct, saveProduct } = require('../lib/firestore');
const { search, fetchText } = require('../lib/evidence-provider');
const { callGeminiStructured } = require('../lib/gemini-structured');
const { buildCommonPolicyText } = require('../lib/llm-policy-pack');

const {
  normalizeManufacturerKey,
  manufacturerKeyCandidates, // not exported; fallback handled via getManufacturerGpsrByName
  normalizeGpsrObject,
  mergePreferMoreComplete,
  scoreGpsr,
  isGpsrPlaceholderLike,
  getManufacturerGpsrByName,
  upsertManufacturerGpsr,
} = require('../lib/gpsr-manufacturer-registry');

function argFlag(name) {
  return process.argv.includes(name);
}
function argValue(name, fallback = null) {
  const idx = process.argv.findIndex((x) => x === name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}
function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}
function normalizeSpaces(text = '') {
  return safeString(text).replace(/\s+/g, ' ').trim();
}
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(
    d.getSeconds()
  )}`;
}

const REQUIRED_FIELDS = [
  'entity_country',
  'manufacturer_name',
  'manufacturer_address',
  'manufacturer_city',
  'manufacturer_postalcode',
  'email',
];

function pickManufacturerName(product) {
  return (
    safeString(product?.details?.gpsr?.manufacturer_name) ||
    safeString(product?.identification?.brand) ||
    safeString(product?.details?.brand) ||
    ''
  );
}

function missingFields(gpsr) {
  const g = gpsr && typeof gpsr === 'object' && !Array.isArray(gpsr) ? gpsr : {};
  const missing = [];
  for (const f of REQUIRED_FIELDS) {
    const v = safeString(g[f]);
    if (!v || isGpsrPlaceholderLike(v)) missing.push(f);
  }
  return missing;
}

function toCsv(rows, header) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(header.map((h) => esc(r[h])).join(','));
  }
  return lines.join('\n') + '\n';
}

function tryParseJsonLenient(text) {
  const raw = (text == null ? '' : String(text)).trim();
  if (!raw) return { ok: false, error: 'empty' };
  const extractFirstFencedBlock = (s) => {
    const m = String(s).match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    return m ? String(m[1]).trim() : String(s);
  };
  const stripOuterFences = (s) =>
    String(s)
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
  const cleaned = stripOuterFences(extractFirstFencedBlock(raw));
  const candidates = [cleaned];
  const firstObj = cleaned.indexOf('{');
  if (firstObj !== -1) candidates.push(cleaned.slice(firstObj));
  const normalizeJsonish = (s) =>
    String(s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/,\s*([}\]])/g, '$1')
      .trim();
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(normalizeJsonish(c));
      if (parsed && typeof parsed === 'object') return { ok: true, parsed };
    } catch {
      // continue
    }
  }
  return { ok: false, error: 'json_parse_failed', rawPreview: cleaned.slice(0, 800) };
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
    manufacturer_url: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number' },
  },
  required: [
    'entity_country',
    'manufacturer_name',
    'manufacturer_address',
    'manufacturer_city',
    'manufacturer_postalcode',
    'manufacturer_state_province',
    'manufacturer_email',
    'manufacturer_phone',
    'manufacturer_url',
    'sources',
    'confidence',
  ],
};

function buildManufacturerQueries(manufacturer) {
  const m = safeString(manufacturer);
  const qs = [
    `${m} Impressum Adresse E-Mail Telefon`,
    `${m} Kontakt Adresse E-Mail Telefon`,
    `${m} manufacturer address email phone`,
    `${m} support email phone address`,
    `${m} GPSR manufacturer address email phone`,
  ];
  return Array.from(new Set(qs.map((x) => normalizeSpaces(x)).filter(Boolean))).slice(0, 8);
}

function buildPrompt({ manufacturer, evidenceBlocks, urls }) {
  const policy = buildCommonPolicyText({ mode: 'gpsr' });
  return normalizeSpaces(`
${policy}

TASK:
Extract GPSR manufacturer/contact data for the manufacturer below using ONLY the provided WEB EVIDENCE.
If a value is not clearly supported by evidence, return an empty string for that field.
Do NOT refuse. Do NOT complain. Do NOT mention policy. Just return JSON matching the schema.

Manufacturer: ${manufacturer}

Fields to extract:
- entity_country (English country name, e.g. "Germany")
- manufacturer_name
- manufacturer_address (street + house number only; no postal code/city/country)
- manufacturer_city
- manufacturer_postalcode
- manufacturer_state_province
- manufacturer_email (support email ok)
- manufacturer_phone (support hotline ok)
- manufacturer_url (official website)

Sources:
You MUST output "sources" as the subset of URLs you used from this list:
${urls.map((u) => `- ${u}`).join('\n')}

WEB EVIDENCE (snippets):
${evidenceBlocks.join('\n\n---\n\n').slice(0, 120_000)}
  `).trim();
}

async function enrichManufacturerOnce(manufacturer, { searchLimit, maxPages, minConfidence }) {
  const m = safeString(manufacturer);
  if (!m) return { ok: false, reason: 'missing_manufacturer' };

  let urls = [];
  let chosenQuery = '';
  for (const q of buildManufacturerQueries(m)) {
    const res = await search(q, { limit: searchLimit, locale: 'de-DE' });
    const found = Array.isArray(res?.results) ? res.results.map((r) => safeString(r?.url)).filter(Boolean) : [];
    if (found.length) {
      chosenQuery = q;
      urls = found.slice(0, maxPages);
      break;
    }
  }
  if (!urls.length) return { ok: false, reason: 'no_search_results', manufacturer: m };

  const pages = (
    await Promise.all(
      urls.map(async (u) => {
        const r = await fetchText(u, { timeoutMs: 30_000 }).catch(() => null);
        if (!r?.ok || !r?.text) return null;
        return { url: u, text: safeString(r.text).slice(0, 250_000) };
      })
    )
  ).filter(Boolean);
  if (!pages.length) return { ok: false, reason: 'no_pages_fetched', manufacturer: m, urls };

  const evidenceBlocks = pages.map((p) => `URL: ${p.url}\n${p.text.slice(0, 25_000)}`);
  const prompt = buildPrompt({ manufacturer: m, evidenceBlocks, urls });

  const jsonText = await callGeminiStructured({
    parts: [{ text: prompt }],
    responseSchema: GPSR_SCHEMA,
    temperature: 0.0,
    maxOutputTokens: 2048,
    stopSequences: [],
  });

  const attempt = tryParseJsonLenient(jsonText);
  if (!attempt.ok) {
    return { ok: false, reason: 'json_parse_failed', manufacturer: m, rawPreview: attempt.rawPreview || null };
  }

  const parsed = attempt.parsed;
  const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
  const modelSources = Array.isArray(parsed.sources) ? parsed.sources.map((x) => safeString(x)).filter(Boolean) : [];
  const effectiveSources = modelSources.length ? modelSources : urls;
  const canApply = effectiveSources.length > 0 && confidence >= minConfidence;

  const extracted = {
    entity_country: safeString(parsed.entity_country),
    manufacturer_name: safeString(parsed.manufacturer_name) || m,
    manufacturer_address: safeString(parsed.manufacturer_address),
    manufacturer_city: safeString(parsed.manufacturer_city),
    manufacturer_postalcode: safeString(parsed.manufacturer_postalcode),
    manufacturer_state_province: safeString(parsed.manufacturer_state_province),
    email: safeString(parsed.manufacturer_email),
    manufacturer_phone: safeString(parsed.manufacturer_phone),
    url: safeString(parsed.manufacturer_url),
  };
  for (const [k, v] of Object.entries(extracted)) {
    if (isGpsrPlaceholderLike(v)) extracted[k] = '';
  }

  return {
    ok: true,
    manufacturer: m,
    chosenQuery,
    confidence,
    canApply,
    sources: effectiveSources.slice(0, 8),
    extracted,
  };
}

async function applyRegistryToProduct(product, { dryRun }) {
  const manufacturerHint = pickManufacturerName(product);
  if (!manufacturerHint) return { ok: false, reason: 'missing_manufacturer' };
  const reg = await getManufacturerGpsrByName(manufacturerHint).catch(() => null);
  const regGpsr = reg?.gpsr && typeof reg.gpsr === 'object' ? reg.gpsr : null;
  if (!regGpsr || !Object.keys(regGpsr).length) return { ok: false, reason: 'no_registry' };

  const existing = product?.details?.gpsr && typeof product.details.gpsr === 'object' ? { ...product.details.gpsr } : {};
  const merged = mergePreferMoreComplete(existing, regGpsr);
  const changed = JSON.stringify(existing) !== JSON.stringify(merged);
  if (!changed) return { ok: true, changed: false };

  if (!dryRun) {
    await saveProduct(
      {
        ...product,
        details: { ...(product.details || {}), gpsr: merged },
        ops: {
          ...(product.ops || {}),
          data_quality: {
            ...((product.ops || {}).data_quality || {}),
            gpsr_registry_apply_v1: {
              at_iso: new Date().toISOString(),
              manufacturer: manufacturerHint,
              registry_key: reg.key,
              registry_confidence: reg.confidence ?? null,
            },
          },
        },
      },
      { source: 'script', skipTitlePolicy: true, skipKeyFeaturesNormalize: true }
    );
  }

  return { ok: true, changed: true, registry_key: reg.key };
}

async function main() {
  const apply = argFlag('--apply');
  const dryRun = !apply;
  const manufacturerLimit = Math.max(
    1,
    parseInt(argValue('--manufacturer-limit', process.env.MANUFACTURER_LIMIT || '99999') || '99999', 10)
  );
  const concurrency = Math.max(1, Math.min(6, parseInt(argValue('--concurrency', process.env.CONCURRENCY || '3') || '3', 10)));
  const applyConcurrency = Math.max(
    1,
    Math.min(12, parseInt(argValue('--apply-concurrency', process.env.APPLY_CONCURRENCY || '6') || '6', 10))
  );
  const minConfidence = Math.max(
    0,
    Math.min(1, parseFloat(argValue('--min-confidence', process.env.GPSR_MIN_APPLY_CONFIDENCE || '0.6') || '0.6') || 0.6)
  );
  const searchLimit = Math.max(3, Math.min(15, parseInt(argValue('--search-limit', process.env.GPSR_SEARCH_LIMIT || '10') || '10', 10)));
  const maxPages = Math.max(1, Math.min(8, parseInt(argValue('--max-pages', process.env.GPSR_ENRICH_MAX_PAGES || '5') || '5', 10)));

  const outDir = path.resolve('backend/exports/gpsr-coverage');
  ensureDir(outDir);

  console.log(
    JSON.stringify(
      {
        action: 'gpsr-ensure-correct-all-products',
        dryRun,
        manufacturerLimit,
        concurrency,
        applyConcurrency,
        minConfidence,
        searchLimit,
        maxPages,
        requiredFields: REQUIRED_FIELDS,
        outDir,
      },
      null,
      2
    )
  );

  const all = await getAllProducts();
  const products = Array.isArray(all) ? all.filter((p) => p?.id) : [];

  // Manufacturer stats
  const groups = new Map(); // key -> { name, key, productIds:[], count, existingBestScore }
  for (const p of products) {
    const m = pickManufacturerName(p);
    const key = normalizeManufacturerKey(m);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { key, name: m, productIds: [], count: 0, bestScore: 0 });
    const g = groups.get(key);
    g.productIds.push(String(p.id));
    g.count += 1;
    const s = scoreGpsr(p?.details?.gpsr);
    if (s > g.bestScore) g.bestScore = s;
  }
  const manufacturerList = Array.from(groups.values())
    .sort((a, b) => b.count - a.count || b.bestScore - a.bestScore || a.key.localeCompare(b.key))
    .slice(0, manufacturerLimit);

  console.log(JSON.stringify({ products: products.length, manufacturers: manufacturerList.length }, null, 2));

  // Phase 1: enrich manufacturers (prioritize those impacting many products)
  const enrichQueue = new PQueue({ concurrency });
  let mProcessed = 0;
  let mApplied = 0;
  let mSkipped = 0;
  let mFailed = 0;

  await Promise.all(
    manufacturerList.map((m) =>
      enrichQueue.add(async () => {
        mProcessed += 1;
        try {
          // If existing registry is already very complete, skip.
          const existing = await getManufacturerGpsrByName(m.name).catch(() => null);
          const existingScore = existing?.gpsr ? scoreGpsr(existing.gpsr) : 0;
          if (existingScore >= 16) {
            mSkipped += 1;
            return;
          }

          const res = await enrichManufacturerOnce(m.name, { searchLimit, maxPages, minConfidence });
          if (!res.ok) {
            mFailed += 1;
            return;
          }
          if (!res.canApply) {
            mSkipped += 1;
            return;
          }
          if (!dryRun) {
            await upsertManufacturerGpsr({
              manufacturer_name: res.extracted.manufacturer_name || m.name,
              gpsr: res.extracted,
              confidence: res.confidence,
              sources: res.sources,
              from_product_id: `manufacturer:${m.name}`,
            });
          }
          mApplied += 1;
        } catch {
          mFailed += 1;
        }
        if (mProcessed % 25 === 0 || mProcessed === 1) {
          console.log(JSON.stringify({ manufacturers_progress: mProcessed, mApplied, mSkipped, mFailed }, null, 2));
        }
      })
    )
  );

  console.log(JSON.stringify({ phase1_done: true, mProcessed, mApplied, mSkipped, mFailed }, null, 2));

  // Phase 2: apply registry to all products
  const applyQueue = new PQueue({ concurrency: applyConcurrency });
  let pProcessed = 0;
  let pUpdated = 0;
  let pSkipped = 0;
  let pFailed = 0;

  await Promise.all(
    products.map((p) =>
      applyQueue.add(async () => {
        pProcessed += 1;
        try {
          const fresh = await getProduct(String(p.id)).catch(() => null);
          const cur = fresh || p;
          const res = await applyRegistryToProduct(cur, { dryRun });
          if (res.ok && res.changed) pUpdated += 1;
          else pSkipped += 1;
        } catch {
          pFailed += 1;
        }
        if (pProcessed % 100 === 0 || pProcessed === 1) {
          console.log(JSON.stringify({ products_progress: pProcessed, pUpdated, pSkipped, pFailed }, null, 2));
        }
      })
    )
  );

  // Report remaining gaps
  const again = await getAllProducts();
  const after = Array.isArray(again) ? again.filter((p) => p?.id) : [];
  const reportRows = [];
  for (const p of after) {
    const g = p?.details?.gpsr;
    const miss = missingFields(g);
    if (!miss.length) continue;
    reportRows.push({
      productId: String(p.id),
      sku: safeString(p?.identification?.sku),
      manufacturer: pickManufacturerName(p),
      missingFields: miss.join('|'),
      gpsrScore: String(scoreGpsr(g)),
    });
  }

  const outCsv = path.join(outDir, `gpsr-coverage-report-${nowStamp()}.csv`);
  fs.writeFileSync(
    outCsv,
    toCsv(reportRows, ['productId', 'sku', 'manufacturer', 'missingFields', 'gpsrScore']),
    'utf8'
  );

  console.log(
    JSON.stringify(
      {
        done: true,
        dryRun,
        manufacturers_total: manufacturerList.length,
        phase1: { processed: mProcessed, applied: mApplied, skipped: mSkipped, failed: mFailed },
        phase2: { products: products.length, processed: pProcessed, updated: pUpdated, skipped: pSkipped, failed: pFailed },
        remaining_missing: reportRows.length,
        report_csv: outCsv,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

