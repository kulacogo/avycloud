/* eslint-disable no-console */
/**
 * Fix obviously wrong/suspicious eBay category assignments using WEB evidence (SerpAPI) + Gemini,
 * validated against the canonical eBay taxonomy (backend/ebay-data/categories.json).
 *
 * Targets (by default):
 * - Products whose current canonical category root is in:
 *   - "Sammeln & Seltenes"
 *   - "Antiquitäten & Kunst"
 *   - "Business & Industrie"
 *
 * Optional (flags):
 * - --include-missing: include products with missing/invalid categoryId
 * - --include-too-broad: include products whose canonical breadcrumb is top-level (no '>')
 *
 * Safety:
 * - Only apply when Gemini proposes a breadcrumb-like category and it maps to a canonical eBay category id.
 * - Require evidence support (leaf token must appear in product text or web evidence).
 * - Writes go through saveProduct(..., { allowCategoryChange: true }) to re-apply required aspects ordering.
 * - Strict pre/post count guard (no creates/deletes).
 *
 * Usage:
 *   node backend/scripts/fix-suspicious-categories-with-web.js --dry-run
 *   node backend/scripts/fix-suspicious-categories-with-web.js --apply --expected-count 420
 */

const fs = require('fs');
const path = require('path');
const PQueue = require('p-queue').default || require('p-queue');
const { getGeminiClient } = require('../lib/gemini-client');
const { resolveModel } = require('../lib/model-select');
const { callSerpApi, summarizeSerpEntries } = require('../lib/serpapi');
const { findEbayCategory } = require('../lib/ebay-taxonomy');
const { getAllProducts, saveProduct } = require('../lib/firestore');
const { buildCommonPolicyText } = require('../lib/llm-policy-pack');
const { MarketplaceLookup } = require('../lib/marketplace-lookup');

const EBAY_CATEGORIES_JSON = path.join(__dirname, '..', 'ebay-data', 'categories.json');
const EBAY_CATEGORIES = JSON.parse(fs.readFileSync(EBAY_CATEGORIES_JSON, 'utf8'));
const marketLookup = new MarketplaceLookup({});

const SUSPICIOUS_ROOTS = new Set(['Sammeln & Seltenes', 'Antiquitäten & Kunst', 'Business & Industrie']);

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function canonicalBreadcrumb(id) {
  const entry = EBAY_CATEGORIES[String(id).trim()];
  return safeString(entry?.breadcrumb);
}

function rootOfBreadcrumb(breadcrumb) {
  const seg = safeString(breadcrumb).split('>').map((s) => s.trim()).filter(Boolean);
  return seg[0] || '';
}

function pickSku(product) {
  return safeString(product?.identification?.sku) || safeString(product?.details?.identifiers?.sku) || safeString(product?.id);
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
  return t.split(/\s+/g).filter((w) => w.length >= 4);
}

const LEAF_STOP = new Set([
  'teile',
  'zubehor',
  'zubehör',
  'set',
  'sets',
  'und',
  'fur',
  'fuer',
  'für',
  'mit',
  'ohne',
  'sonstige',
  'zubehoer',
]);

function strongLeafTokens(text = '') {
  return tokenize(text).filter((t) => t.length >= 6 && !LEAF_STOP.has(t));
}

function isLeafCompatible(proposedPath, canonicalPath) {
  const proposedLeaf = safeString(String(proposedPath || '').split('>').pop() || '');
  const canonicalLeaf = safeString(String(canonicalPath || '').split('>').pop() || '');
  if (!proposedLeaf || !canonicalLeaf) return false;
  const a = new Set(strongLeafTokens(proposedLeaf));
  const b = new Set(strongLeafTokens(canonicalLeaf));
  // If we don't have strong tokens (very short leafs), fall back to regular tokens.
  const a2 = a.size ? a : new Set(tokenize(proposedLeaf).filter((t) => !LEAF_STOP.has(t)));
  const b2 = b.size ? b : new Set(tokenize(canonicalLeaf).filter((t) => !LEAF_STOP.has(t)));
  let overlap = 0;
  for (const t of a2) {
    if (b2.has(t)) overlap += 1;
  }
  return overlap >= 1;
}

function pickQuery(product) {
  const ids = product?.details?.identifiers || {};
  const attrs = product?.details?.attributes || {};
  const barcode = safeString(ids.ean) || safeString(ids.gtin) || safeString(ids.upc) || safeString(product?.identification?.barcodes?.[0]);
  if (barcode && barcode.replace(/\D+/g, '').length >= 8) return barcode.replace(/\D+/g, '');
  const brand = safeString(product?.identification?.brand);
  const mpn = safeString(ids.mpn) || safeString(attrs.Herstellernummer);
  if (brand && mpn) return `${brand} ${mpn}`;
  const title = safeString(product?.identification?.name);
  if (brand && title) return `${brand} ${title.split(/\s+/).slice(0, 7).join(' ')}`;
  return title.split(/\s+/).slice(0, 8).join(' ');
}

function hasEvidenceForLeaf(product, breadcrumb, webBlocks = []) {
  const leaf = safeString(String(breadcrumb || '').split('>').pop() || '');
  const rawTokens = tokenize(leaf);
  const leafTokens = new Set(rawTokens);
  const strongTokens = rawTokens.filter((t) => t.length >= 6 && !LEAF_STOP.has(t));
  if (!leafTokens.size) return false;

  const attrs = product?.details?.attributes && typeof product.details.attributes === 'object' ? product.details.attributes : {};
  const productText = [
    product?.identification?.name,
    product?.identification?.brand,
    attrs?.Produktart,
    attrs?.Produkttyp,
    attrs?.['Produkttyp (Produktart)'],
  ]
    .filter(Boolean)
    .join(' ');
  const webText = (webBlocks || [])
    .flatMap((b) => (Array.isArray(b?.items) ? b.items : []))
    .map((it) => `${it.title || ''} ${it.snippet || ''}`.trim())
    .join(' ');

  const evidenceTokens = new Set(tokenize(`${productText} ${webText}`));
  // Prefer strong tokens first (avoid false positives like "Deck" matching deck-box categories).
  const tryTokens = strongTokens.length ? strongTokens : Array.from(leafTokens);
  for (const t of tryTokens) {
    if (evidenceTokens.has(t)) return true;
    for (const e of evidenceTokens) {
      if (e.length >= 6 && (e.includes(t) || t.includes(e))) return true;
    }
  }
  // If no strong token exists, require at least 2 leaf tokens to match.
  if (!strongTokens.length) {
    let matches = 0;
    for (const t of leafTokens) {
      if (evidenceTokens.has(t)) matches += 1;
      if (matches >= 2) return true;
    }
  }
  return false;
}

async function fetchWebBlocks(query) {
  const blocks = [];
  const engines = [
    { engine: 'google', params: { q: query, num: 8 } },
    { engine: 'google_shopping', params: { q: query, num: 8 } },
    { engine: 'ebay', params: { _nkw: query } }, // ebay uses _nkw often; if it fails, we still have google
  ];
  for (const spec of engines) {
    try {
      const raw = await callSerpApi(spec.engine, spec.params);
      const items = summarizeSerpEntries(spec.engine, raw, 6);
      blocks.push({
        engine: spec.engine,
        query,
        items: items.map((it) => ({
          title: it.title,
          source: it.source,
          url: it.url,
          snippet: it.snippet,
        })),
      });
    } catch (err) {
      blocks.push({ engine: spec.engine, query, error: err?.message || String(err) });
    }
  }
  return blocks;
}

async function proposeCategoryPathWithGemini({ product, locale, webBlocks }) {
  const client = await getGeminiClient();
  const modelName = resolveModel(null, 'CATEGORY_FIX_MODEL', 'gemini-2.5-flash');
  const model = client.getGenerativeModel({ model: modelName });

  const attrs = product?.details?.attributes && typeof product.details.attributes === 'object' ? product.details.attributes : {};
  const snapshot = {
    sku: pickSku(product),
    title: safeString(product?.identification?.name),
    brand: safeString(product?.identification?.brand),
    category_current: safeString(product?.identification?.category),
    category_id_current: safeString(product?.details?.categoryId),
    mpn: safeString(product?.details?.identifiers?.mpn) || safeString(attrs.Herstellernummer),
    produktart: safeString(attrs.Produktart) || safeString(attrs.Produkttyp),
  };

  const prompt = [
    'Du bist ein eBay.de Kategorie-Assistent.',
    buildCommonPolicyText({ locale, allowWebEvidence: true }),
    '',
    'AUFGABE:',
    '- Liefere NUR JSON: { "path": "A > B > C" }',
    '- Der Pfad MUSS ein realer eBay Kategorie-Breadcrumb sein (mindestens 2 Ebenen, muss ">").',
    '- Wähle die BESTE & MÖGLICHST SPEZIFISCHE Kategorie.',
    '- Vermeide diese Roots, außer es ist eindeutig passend: "Sammeln & Seltenes", "Antiquitäten & Kunst", "Business & Industrie".',
    '- Keine Erklärungen, kein Markdown.',
    '',
    'PRODUKT:',
    JSON.stringify(snapshot, null, 2),
    '',
    'WEB-EVIDENZ:',
    JSON.stringify({ blocks: webBlocks }, null, 2),
  ].join('\n');

  const generationConfig = {
    temperature: 0.2,
    topP: 0.95,
    topK: 64,
    responseMimeType: 'application/json',
    responseSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  };

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
  });
  const json = JSON.parse(result.response.text());
  return safeString(json?.path);
}

function isBreadcrumb(text) {
  const t = safeString(text);
  return t.includes('>') && t.split('>').map((s) => s.trim()).filter(Boolean).length >= 2;
}

function resolveCategoryFromPath(proposedPath) {
  // Prefer unique leaf matches first (safest, avoids fuzzy wrong-path resolutions).
  const leaf = safeString(String(proposedPath || '').split('>').pop() || '');
  const byUniqueLeaf = leaf ? marketLookup.lookupEbay(leaf) : null;
  if (byUniqueLeaf) return { id: String(byUniqueLeaf), method: 'marketplaceLookup_leaf' };
  // Next: full path lookup (exact)
  const byLookup = marketLookup.lookupEbay(proposedPath);
  if (byLookup) return { id: String(byLookup), method: 'marketplaceLookup' };
  // Last: strict matcher / heuristics
  const byFind = findEbayCategory(proposedPath);
  if (byFind?.id) return { id: String(byFind.id), method: 'findEbayCategory' };
  return null;
}

function parseArgs(argv) {
  const args = {
    dryRun: true,
    apply: false,
    expectedCount: 420,
    concurrency: 2,
    limit: 0,
    includeMissing: false,
    includeTooBroad: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--apply') {
      args.apply = true;
      args.dryRun = false;
    }
    if (t === '--dry-run') {
      args.dryRun = true;
      args.apply = false;
    }
    if (t === '--expected-count') {
      args.expectedCount = Number(argv[i + 1]);
      i += 1;
    }
    if (t === '--concurrency') {
      args.concurrency = Number(argv[i + 1]);
      i += 1;
    }
    if (t === '--limit') {
      args.limit = Number(argv[i + 1]);
      i += 1;
    }
    if (t === '--include-missing') {
      args.includeMissing = true;
    }
    if (t === '--include-too-broad') {
      args.includeTooBroad = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const outDir = path.join(process.cwd(), 'exports', 'category-fix-web', stamp);
  ensureDir(outDir);

  console.log(`[category-fix-web] mode=${args.apply ? 'APPLY' : 'DRY_RUN'} out=${outDir}`);
  const products = await getAllProducts();
  const preCount = products.length;
  console.log(`[category-fix-web] preCount=${preCount}`);
  if (args.apply && preCount !== args.expectedCount) {
    throw new Error(`[category-fix-web] ABORT: expected preCount=${args.expectedCount} but got ${preCount}`);
  }

  const targetsAll = products.filter((p) => {
    const id = safeString(p?.details?.categoryId);
    const canon = id ? canonicalBreadcrumb(id) : '';
    if (!id) return Boolean(args.includeMissing);
    if (!canon) return Boolean(args.includeMissing);
    if (!canon.includes('>')) return Boolean(args.includeTooBroad);
    const root = rootOfBreadcrumb(canon);
    return SUSPICIOUS_ROOTS.has(root);
  });
  const targets = args.limit > 0 ? targetsAll.slice(0, args.limit) : targetsAll;
  console.log(`[category-fix-web] targets=${targetsAll.length} processing=${targets.length}`);

  const queue = new PQueue({ concurrency: Math.max(1, args.concurrency || 2) });
  const report = [];

  for (const product of targets) {
    queue.add(async () => {
      const sku = pickSku(product);
      const currentId = safeString(product?.details?.categoryId);
      const currentCanon = currentId ? canonicalBreadcrumb(currentId) : '';
      const currentRoot = rootOfBreadcrumb(currentCanon);

      const query = pickQuery(product);
      const locale = product?.locale || 'de-DE';
      const webBlocks = await fetchWebBlocks(query);
      const proposedPath = await proposeCategoryPathWithGemini({ product, locale, webBlocks });
      if (!isBreadcrumb(proposedPath)) {
        report.push({ sku, status: 'skip', reason: 'not_breadcrumb', query, current: currentCanon, proposedPath });
        return;
      }
      const resolved = resolveCategoryFromPath(proposedPath);
      if (!resolved?.id) {
        report.push({ sku, status: 'skip', reason: 'not_in_taxonomy', query, current: currentCanon, proposedPath });
        return;
      }
      const canon = canonicalBreadcrumb(resolved.id);
      if (!isBreadcrumb(canon)) {
        report.push({ sku, status: 'skip', reason: 'canonical_too_broad', query, current: currentCanon, proposedPath, resolvedId: String(resolved.id), canonical: canon, resolvedBy: resolved.method });
        return;
      }
      // Guard: proposed leaf and canonical leaf must be compatible (avoid wrong fuzzy matches).
      if (!isLeafCompatible(proposedPath, canon)) {
        report.push({ sku, status: 'skip', reason: 'leaf_incompatible', query, current: currentCanon, proposedPath, resolvedId: String(resolved.id), canonical: canon, resolvedBy: resolved.method });
        return;
      }
      // Extra evidence guard
      if (!hasEvidenceForLeaf(product, canon, webBlocks)) {
        report.push({ sku, status: 'skip', reason: 'no_leaf_evidence', query, current: currentCanon, proposedPath, resolvedId: String(resolved.id), canonical: canon, resolvedBy: resolved.method });
        return;
      }
      // If it doesn't actually improve anything, skip
      if (currentId && String(currentId) === String(resolved.id)) {
        report.push({ sku, status: 'noop', query, current: currentCanon, resolvedId: String(resolved.id), canonical: canon, resolvedBy: resolved.method });
        return;
      }
      // Avoid moving into suspicious roots unless web evidence indicates it (we keep the evidence guard, but add root guard)
      const nextRoot = rootOfBreadcrumb(canon);
      if (SUSPICIOUS_ROOTS.has(nextRoot) && !SUSPICIOUS_ROOTS.has(currentRoot)) {
        // do not move into suspicious roots from a non-suspicious root
        report.push({ sku, status: 'skip', reason: 'avoid_into_suspicious_root', query, current: currentCanon, proposedPath, resolvedId: String(cat.id), canonical: canon });
        return;
      }

      report.push({
        sku,
        status: args.apply ? 'update' : 'would_update',
        query,
        current: currentCanon,
        currentId,
        proposedPath,
        resolvedId: String(resolved.id),
        canonical: canon,
        resolvedBy: resolved.method,
      });

      if (!args.apply) return;

      const next = JSON.parse(JSON.stringify(product));
      if (!next.details) next.details = {};
      next.details.categoryId = String(resolved.id);
      if (!next.identification) next.identification = {};
      next.identification.category = canon;
      next.ops = next.ops || {};
      next.ops.data_quality = {
        ...(next.ops.data_quality || {}),
        category_fix_web_v1: {
          iso: new Date().toISOString(),
          from: currentCanon || null,
          to: canon,
          query,
        },
      };

      // Go through saveProduct to re-apply aspect ordering and invariants.
      await saveProduct(next, { source: 'category-fix-web', allowCategoryChange: true });
    });
  }

  await queue.onIdle();

  const summary = {
    preCount,
    targets: targetsAll.length,
    processed: targets.length,
    would_update: report.filter((r) => r.status === 'would_update').length,
    update: report.filter((r) => r.status === 'update').length,
    noop: report.filter((r) => r.status === 'noop').length,
    skip: report.filter((r) => r.status === 'skip').length,
    skipReasons: {},
  };
  report
    .filter((r) => r.status === 'skip')
    .forEach((r) => {
      summary.skipReasons[r.reason] = (summary.skipReasons[r.reason] || 0) + 1;
    });

  fs.writeFileSync(path.join(outDir, args.apply ? 'apply_report.json' : 'dryrun_report.json'), JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, args.apply ? 'apply_summary.json' : 'dryrun_summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  console.log(`[category-fix-web] summary would_update=${summary.would_update} update=${summary.update} noop=${summary.noop} skip=${summary.skip}`);
  if (!args.apply) {
    console.log('[category-fix-web] Dry-run complete. No writes performed.');
    return;
  }

  const post = await getAllProducts();
  const postCount = post.length;
  console.log(`[category-fix-web] postCount=${postCount}`);
  if (postCount !== preCount) {
    throw new Error(`[category-fix-web] COUNT MISMATCH pre=${preCount} post=${postCount}`);
  }
  console.log(`[category-fix-web] SUCCESS. Reports in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


