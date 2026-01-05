/* eslint-disable no-console */
/**
 * Suggest eBay categoryId/breadcrumb for each row in a review CSV by:
 * - fetching web evidence (SerpAPI) using barcode/title/brand/mpn and optional reverse-image
 * - building a candidate shortlist from the canonical taxonomy (backend/ebay-data/categories.json)
 * - asking Gemini to pick ONE categoryId strictly from the provided shortlist
 *
 * Output:
 * - A new CSV with TargetCategoryBreadcrumb/TargetCategoryId filled (suggestions)
 * - A JSON report with per-SKU details (queries, evidence URLs, candidate list, chosen id)
 *
 * Safety:
 * - Never writes to Firestore. This only generates suggestions for human review.
 * - Gemini is constrained: MUST choose from the candidate list we provide.
 *
 * Usage:
 *   node backend/scripts/suggest-ebay-categories-for-review-csv.js \
 *     --in exports/category_review_suspicious_roots_*.csv \
 *     --out exports/category_review_suspicious_roots__suggested.csv \
 *     --concurrency 2
 */

const fs = require('fs');
const path = require('path');
const PQueue = require('p-queue').default || require('p-queue');
const { parse } = require('csv-parse/sync');

const { getAllProducts } = require('../lib/firestore');
const { callSerpApi, summarizeSerpEntries } = require('../lib/serpapi');
const { getGeminiClient } = require('../lib/gemini-client');
const { resolveModel } = require('../lib/model-select');
const { buildCommonPolicyText } = require('../lib/llm-policy-pack');

const EBAY_CATEGORIES_JSON = path.join(__dirname, '..', 'ebay-data', 'categories.json');
const EBAY_CATEGORIES = JSON.parse(fs.readFileSync(EBAY_CATEGORIES_JSON, 'utf8'));

const SUSPICIOUS_ROOTS = new Set(['Sammeln & Seltenes', 'Antiquitäten & Kunst', 'Business & Industrie']);

// Gemini function/response schemas reject some JSON Schema keywords (e.g. additionalProperties/default).
function cleanSchemaForGemini(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(cleanSchemaForGemini);
  const cleaned = { ...schema };
  if (Array.isArray(cleaned.type)) {
    const validTypes = cleaned.type.filter((t) => t !== 'null');
    cleaned.type = validTypes.length === 1 ? validTypes[0] : validTypes[0] || 'string';
  }
  if (cleaned.properties) {
    const next = {};
    for (const [k, v] of Object.entries(cleaned.properties)) {
      next[k] = cleanSchemaForGemini(v);
    }
    cleaned.properties = next;
  }
  if (cleaned.items) cleaned.items = cleanSchemaForGemini(cleaned.items);
  delete cleaned.additionalProperties;
  delete cleaned.default;
  return cleaned;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function normalizeText(text = '') {
  return safeString(text)
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss')
    .replace(/[\u2010-\u2015-]/g, ' ')
    .replace(/[^\p{L}\p{N}\s>]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text = '') {
  const t = normalizeText(text);
  if (!t) return [];
  const stop = new Set([
    'und', 'oder', 'fur', 'fuer', 'für', 'mit', 'ohne', 'set', 'neu', 'new', 'original', 'ovp',
    'teile', 'zubehor', 'zubehör', 'sonstige', 'der', 'die', 'das', 'ein', 'eine',
  ]);
  return t
    .split(/\s+/g)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && !stop.has(w));
}

function canonicalBreadcrumb(id) {
  const entry = EBAY_CATEGORIES[String(id || '').trim()];
  return safeString(entry?.breadcrumb);
}

function rootOfBreadcrumb(breadcrumb) {
  const seg = safeString(breadcrumb).split('>').map((s) => s.trim()).filter(Boolean);
  return seg[0] || '';
}

function pickFirstImageUrl(product) {
  const images = Array.isArray(product?.details?.images) ? product.details.images : [];
  const url = images.map((img) => img?.url_or_base64 || img?.url || img?.href).find((u) => typeof u === 'string' && u.startsWith('http'));
  return url || '';
}

function pickProductSignals(product) {
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  const ids = product?.details?.identifiers || {};
  const barcode = safeString(ids.ean) || safeString(ids.gtin) || safeString(ids.upc) ||
    (Array.isArray(product?.identification?.barcodes) ? safeString(product.identification.barcodes[0]) : '');
  const brand = safeString(product?.identification?.brand);
  const title = safeString(product?.identification?.name);
  const mpn = safeString(ids.mpn) || safeString(attrs.Herstellernummer);
  const produktart = safeString(attrs.Produktart) || safeString(attrs.Produkttyp) || safeString(attrs['Produkttyp (Produktart)']);
  return { barcode, brand, title, mpn, produktart };
}

function buildQuery({ barcode, brand, mpn, title, produktart }) {
  const digits = barcode.replace(/\D+/g, '');
  if (digits.length >= 8) return digits;
  if (brand && mpn) return `${brand} ${mpn}`;
  if (brand && produktart) return `${brand} ${produktart}`;
  if (brand && title) return `${brand} ${title.split(/\s+/).slice(0, 7).join(' ')}`;
  return title.split(/\s+/).slice(0, 10).join(' ');
}

async function fetchWebEvidence({ query, imageUrl }) {
  const blocks = [];
  const engines = [
    { engine: 'google', params: { q: query, num: 10 } },
    { engine: 'google_shopping', params: { q: query, num: 10 } },
  ];
  for (const spec of engines) {
    try {
      const raw = await callSerpApi(spec.engine, spec.params);
      const items = summarizeSerpEntries(spec.engine, raw, 8);
      blocks.push({
        engine: spec.engine,
        query,
        items: items.map((it) => ({ title: it.title, source: it.source, url: it.url, snippet: it.snippet })),
      });
    } catch (err) {
      blocks.push({ engine: spec.engine, query, error: err?.message || String(err) });
    }
  }
  if (imageUrl) {
    try {
      const raw = await callSerpApi('google_reverse_image', { image_url: imageUrl });
      const items = summarizeSerpEntries('google_reverse_image', raw, 8);
      blocks.push({
        engine: 'google_reverse_image',
        query: imageUrl,
        items: items.map((it) => ({ title: it.title, source: it.source, url: it.url, snippet: it.snippet })),
      });
    } catch (err) {
      blocks.push({ engine: 'google_reverse_image', query: imageUrl, error: err?.message || String(err) });
    }
  }
  return blocks;
}

function buildEvidenceText(blocks = []) {
  const lines = [];
  for (const b of blocks) {
    lines.push(`ENGINE=${b.engine} QUERY=${b.query}`);
    if (b.error) {
      lines.push(`ERROR: ${b.error}`);
      lines.push('');
      continue;
    }
    const items = Array.isArray(b.items) ? b.items : [];
    items.slice(0, 8).forEach((it, idx) => {
      lines.push(`${idx + 1}. ${safeString(it.title)} | ${safeString(it.source)} | ${safeString(it.url)}`);
      if (it.snippet) lines.push(`   ${safeString(it.snippet)}`);
    });
    lines.push('');
  }
  return lines.join('\n');
}

function scoreCategory(category, evidenceTokens, productTokens) {
  const breadcrumb = safeString(category?.breadcrumb);
  if (!breadcrumb || !breadcrumb.includes('>')) return -Infinity;
  const leaf = safeString(breadcrumb.split('>').pop() || '');
  const leafTokens = tokenize(leaf);
  const bcTokens = tokenize(breadcrumb);
  const nameTokens = tokenize(category?.name || '');

  const overlap = (a, b) => {
    const setB = new Set(b);
    let c = 0;
    for (const t of a) {
      if (setB.has(t)) c += 1;
      else {
        for (const u of setB) {
          if (t.length >= 6 && (u.includes(t) || t.includes(u))) { c += 1; break; }
        }
      }
    }
    return c;
  };

  const leafOverlap = overlap(productTokens, leafTokens) + overlap(evidenceTokens, leafTokens) * 1.2;
  const bcOverlap = overlap(productTokens, bcTokens) + overlap(evidenceTokens, bcTokens) * 0.8;
  const nameOverlap = overlap(productTokens, nameTokens) + overlap(evidenceTokens, nameTokens) * 0.5;

  const depth = breadcrumb.split('>').map((s) => s.trim()).filter(Boolean).length;
  const root = rootOfBreadcrumb(breadcrumb);

  let penalty = 0;
  if (/sonstige/i.test(leaf)) penalty += 8;
  if (SUSPICIOUS_ROOTS.has(root)) penalty += 6;
  if (depth <= 2) penalty += 3;

  return leafOverlap * 80 + bcOverlap * 12 + nameOverlap * 10 + depth - penalty;
}

function buildCandidateShortlist({ productText, evidenceText }, { limit = 60 } = {}) {
  const evidenceTokens = tokenize(evidenceText);
  const productTokens = tokenize(productText);

  const list = Object.values(EBAY_CATEGORIES || {})
    .map((c) => ({
      id: c?.id != null ? String(c.id) : '',
      name: safeString(c?.name),
      breadcrumb: safeString(c?.breadcrumb),
    }))
    .filter((c) => c.id && c.breadcrumb && c.breadcrumb.includes('>'));

  const scored = [];
  for (const c of list) {
    const score = scoreCategory(c, evidenceTokens, productTokens);
    if (!Number.isFinite(score)) continue;
    scored.push({ ...c, score: Number(score.toFixed(3)) });
  }
  scored.sort((a, b) => b.score - a.score);

  // Hard floor: keep only reasonably matching candidates
  const top = scored.slice(0, limit);
  return top;
}

async function chooseCategoryWithGemini({ locale, productSnapshot, evidenceText, candidates }) {
  const client = await getGeminiClient();
  const modelName = resolveModel(null, 'CATEGORY_SUGGEST_MODEL', 'gemini-2.5-flash');
  const model = client.getGenerativeModel({ model: modelName });

  const candidateList = candidates.map((c, idx) => ({
    rank: idx + 1,
    id: c.id,
    breadcrumb: c.breadcrumb,
    score: c.score,
  }));
  const allowedIds = new Set(candidateList.map((c) => c.id));

  const prompt = [
    'Du bist ein eBay.de Kategorie-Experte.',
    buildCommonPolicyText({ locale, allowWebEvidence: true }),
    '',
    'AUFGABE:',
    '- Wähle GENAU EINE KategorieId aus der Kandidatenliste. Du darfst KEINE anderen IDs erfinden.',
    '- Wähle die logisch sinnvollste Kategorie für das Produkt (nicht zu broad, kein "Sonstige" wenn vermeidbar).',
    '- Vermeide die Roots "Sammeln & Seltenes", "Antiquitäten & Kunst", "Business & Industrie", außer es ist eindeutig korrekt.',
    '',
    'PRODUKT:',
    JSON.stringify(productSnapshot, null, 2),
    '',
    'WEB-EVIDENZ:',
    evidenceText.slice(0, 9000),
    '',
    'KANDIDATEN (du MUSST eine categoryId aus dieser Liste wählen):',
    JSON.stringify(candidateList, null, 2),
  ].join('\n');

  const generationConfig = {
    temperature: 0.2,
    topP: 0.9,
    topK: 64,
    responseMimeType: 'application/json',
    responseSchema: cleanSchemaForGemini({
      type: 'object',
      required: ['categoryId', 'rationale'],
      properties: {
        categoryId: { type: 'string' },
        rationale: { type: 'string' },
      },
    }),
  };

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
  });

  const json = JSON.parse(result.response.text());
  const categoryId = safeString(json?.categoryId);
  const rationale = safeString(json?.rationale);
  if (!categoryId || !allowedIds.has(categoryId)) {
    return { categoryId: '', rationale: `Model returned invalid categoryId: ${categoryId || '(empty)'}` };
  }
  return { categoryId, rationale };
}

function normalizeNewlines(value) {
  return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = normalizeNewlines(value);
  if (/[",\n]/.test(str) || /^\s|\s$/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function loadCsv(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_quotes: true,
    bom: true,
  });
}

function parseArgs(argv) {
  const args = {
    in: null,
    out: null,
    reportOut: null,
    concurrency: 2,
    limit: 0,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--in') { args.in = argv[i + 1]; i += 1; }
    else if (t === '--out') { args.out = argv[i + 1]; i += 1; }
    else if (t === '--report-out') { args.reportOut = argv[i + 1]; i += 1; }
    else if (t === '--concurrency') { args.concurrency = Number(argv[i + 1]); i += 1; }
    else if (t === '--limit') { args.limit = Number(argv[i + 1]); i += 1; }
  }
  if (!args.in) throw new Error('Missing --in <csv>');
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const inPath = path.isAbsolute(args.in) ? args.in : path.join(process.cwd(), args.in);
  const outPath = args.out
    ? (path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out))
    : path.join(process.cwd(), 'exports', `category_review_suspicious_roots__suggested_${stamp}.csv`);
  const reportPath = args.reportOut
    ? (path.isAbsolute(args.reportOut) ? args.reportOut : path.join(process.cwd(), args.reportOut))
    : path.join(process.cwd(), 'exports', `category_review_suspicious_roots__suggested_${stamp}.json`);
  ensureDir(path.dirname(outPath));
  ensureDir(path.dirname(reportPath));

  const rowsAll = loadCsv(inPath);
  const rows = args.limit > 0 ? rowsAll.slice(0, args.limit) : rowsAll;

  const products = await getAllProducts();
  const bySku = new Map();
  const byId = new Map();
  for (const p of products) {
    const sku = safeString(p?.identification?.sku) || safeString(p?.details?.identifiers?.sku);
    if (sku) bySku.set(sku, p);
    const id = safeString(p?.id);
    if (id) byId.set(id, p);
  }

  const cacheEvidence = new Map(); // key -> blocks
  const queue = new PQueue({ concurrency: Math.max(1, args.concurrency || 2) });
  const report = [];

  for (const row of rows) {
    queue.add(async () => {
      const sku = safeString(row.SKU);
      const docId = safeString(row.DocId);
      const product = (sku && bySku.get(sku)) || (docId && byId.get(docId)) || null;
      if (!product) {
        report.push({ sku, status: 'skip', reason: 'product_not_found' });
        return;
      }

      const locale = product?.locale || 'de-DE';
      const signals = pickProductSignals(product);
      const imageUrl = pickFirstImageUrl(product);
      const query = buildQuery(signals);

      const cacheKey = `${query}::${imageUrl || ''}`;
      let blocks = cacheEvidence.get(cacheKey);
      if (!blocks) {
        blocks = await fetchWebEvidence({ query, imageUrl });
        cacheEvidence.set(cacheKey, blocks);
      }
      const evidenceText = buildEvidenceText(blocks);

      const attrs = product?.details?.attributes && typeof product.details.attributes === 'object' ? product.details.attributes : {};
      const productSnapshot = {
        sku,
        title: safeString(product?.identification?.name),
        brand: safeString(product?.identification?.brand),
        produktart: safeString(attrs.Produktart) || safeString(attrs.Produkttyp),
        mpn: safeString(product?.details?.identifiers?.mpn) || safeString(attrs.Herstellernummer),
        barcode: signals.barcode ? signals.barcode.replace(/\D+/g, '') : '',
        currentCategoryId: safeString(product?.details?.categoryId),
        currentBreadcrumb: canonicalBreadcrumb(product?.details?.categoryId),
      };

      const productText = [
        productSnapshot.title,
        productSnapshot.brand,
        productSnapshot.produktart,
        productSnapshot.mpn,
        productSnapshot.currentBreadcrumb,
      ].filter(Boolean).join(' ');

      const candidates = buildCandidateShortlist({ productText, evidenceText }, { limit: 70 });
      const { categoryId, rationale } = await chooseCategoryWithGemini({
        locale,
        productSnapshot,
        evidenceText,
        candidates,
      });

      const breadcrumb = categoryId ? canonicalBreadcrumb(categoryId) : '';
      const root = rootOfBreadcrumb(breadcrumb);
      const ok = Boolean(categoryId && breadcrumb && breadcrumb.includes('>'));

      report.push({
        sku,
        status: ok ? 'suggested' : 'skip',
        query,
        imageUrl: imageUrl || null,
        chosen: categoryId || null,
        breadcrumb: breadcrumb || null,
        chosenRoot: root || null,
        rationale,
        candidates: candidates.slice(0, 15),
      });
    });
  }

  await queue.onIdle();

  // map sku -> suggestion
  const bySuggestion = new Map();
  for (const r of report) {
    if (r && r.sku) bySuggestion.set(r.sku, r);
  }

  const headers = Object.keys(rowsAll[0] || {});
  const outHeaders = Array.from(new Set([
    ...headers,
    'TargetCategoryBreadcrumb',
    'TargetCategoryId',
    'Notes',
  ]));

  const outLines = [];
  outLines.push(outHeaders.map(csvEscape).join(','));

  for (const row of rowsAll) {
    const sku = safeString(row.SKU);
    const sugg = sku ? bySuggestion.get(sku) : null;
    const next = { ...row };

    if (sugg && sugg.status === 'suggested') {
      next.TargetCategoryId = safeString(sugg.chosen);
      next.TargetCategoryBreadcrumb = safeString(sugg.breadcrumb);
      const note = `LLM_SUGGESTED query=${safeString(sugg.query)} root=${safeString(sugg.chosenRoot)} rationale=${safeString(sugg.rationale).slice(0, 220)}`;
      next.Notes = next.Notes ? `${note} | ${safeString(next.Notes)}` : note;
    } else if (sugg) {
      const note = `LLM_SKIP query=${safeString(sugg.query)} reason=${safeString(sugg.rationale).slice(0, 220)}`;
      next.Notes = next.Notes ? `${note} | ${safeString(next.Notes)}` : note;
    } else {
      const note = 'LLM_SKIP not_processed';
      next.Notes = next.Notes ? `${note} | ${safeString(next.Notes)}` : note;
    }

    outLines.push(outHeaders.map((h) => csvEscape(next[h] ?? '')).join(','));
  }

  fs.writeFileSync(outPath, `${outLines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(reportPath, JSON.stringify({ stamp, input: inPath, output: outPath, rows: report }, null, 2), 'utf8');

  const suggested = report.filter((r) => r.status === 'suggested').length;
  const skipped = report.length - suggested;
  console.log(`[category-suggest] processed=${report.length} suggested=${suggested} skipped=${skipped}`);
  console.log(`[category-suggest] out=${outPath}`);
  console.log(`[category-suggest] report=${reportPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


