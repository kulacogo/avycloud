/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Add --tenant flag for multi-tenant runs.
 */
/**
 * Export a review CSV for products whose CURRENT eBay category breadcrumb appears mismatched
 * compared to a deterministic taxonomy search using product signals (title/brand/produktart).
 *
 * This is designed to catch cases like in the screenshot:
 * - random "Auto & Motorrad" roots for electronics/home items
 * - overly generic/irrelevant branches like "Automobile > Smart" for a hygrometer
 *
 * Output: CSV with TargetCategoryId/Breadcrumb prefilled when confidence is high.
 *
 * Safety:
 * - No Firestore writes.
 * - Suggestions come ONLY from backend/ebay-data/categories.json (no guessing).
 *
 * Usage:
 *   node backend/scripts/export-category-review-root-mismatches.js
 *   node backend/scripts/export-category-review-root-mismatches.js --out exports/category_review_root_mismatches.csv
 *   node backend/scripts/export-category-review-root-mismatches.js --limit 500
 */

const fs = require('fs');
const path = require('path');
const { getAllProducts, getAllProductsForTenant } = require('../lib/firestore');


// D.0b-Hardening 2026-05-11: read script — default avycloud OK, but log effective tenant prominently
const TENANT_ID = process.env.TENANT_ID || 'avycloud';
console.log('[INFO] Running with TENANT_ID=%s (read-only; override via TENANT_ID env var)', TENANT_ID);
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
    'und',
    'oder',
    'fur',
    'fuer',
    'für',
    'mit',
    'ohne',
    'set',
    'neu',
    'new',
    'original',
    'ovp',
    'teile',
    'zubehor',
    'zubehör',
    'sonstige',
    'der',
    'die',
    'das',
    'ein',
    'eine',
  ]);
  return t
    .split(/\s+/g)
    .map((w) => w.trim())
    .filter((w) => w.length >= 4 && !stop.has(w));
}

function rootOfBreadcrumb(breadcrumb) {
  const seg = safeString(breadcrumb)
    .split('>')
    .map((s) => s.trim())
    .filter(Boolean);
  return seg[0] || '';
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (/[",\n]/.test(str) || /^\s|\s$/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function loadEbayCategories() {
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require('../ebay-data/categories.json');
}

function canonicalBreadcrumb(categories, id) {
  const key = safeString(id);
  if (!key) return '';
  return safeString(categories?.[key]?.breadcrumb);
}

function pickSku(product) {
  return (
    safeString(product?.identification?.sku) ||
    safeString(product?.details?.identifiers?.sku) ||
    safeString(product?.id) ||
    ''
  );
}

function pickProduktart(product) {
  const attrs =
    product?.details?.attributes && typeof product.details.attributes === 'object'
      ? product.details.attributes
      : {};
  return (
    safeString(attrs.Produktart) ||
    safeString(attrs.Produkttyp) ||
    safeString(attrs['Produkttyp (Produktart)']) ||
    safeString(attrs.Artikeltyp) ||
    ''
  );
}

function buildCandidates(categories, tokens = [], { limit = 5 } = {}) {
  const SUSPICIOUS_ROOTS = new Set([
    'Briefmarken',
    'Münzen',
    'Antiquitäten & Kunst',
    'Sammeln & Seltenes',
    'Immobilien',
    'Business & Industrie',
  ]);
  const entries = Object.keys(categories || {})
    .map((id) => {
      const c = categories[id];
      const breadcrumb = safeString(c?.breadcrumb);
      if (!breadcrumb || !breadcrumb.includes('>')) return null;
      const root = rootOfBreadcrumb(breadcrumb);
      if (root && SUSPICIOUS_ROOTS.has(root)) return null;
      return { id: String(c?.id ?? id), breadcrumb, name: safeString(c?.name) };
    })
    .filter(Boolean);

  const scored = [];
  for (const e of entries) {
    const hay = normalizeText(`${e.breadcrumb} ${e.name}`);
    let hit = 0;
    for (const t of tokens) {
      if (hay.includes(t)) hit += 1;
    }
    if (hit === 0) continue;
    scored.push({ ...e, hit, score: hit * 1000 - hay.length });
  }
  scored.sort((a, b) => b.hit - a.hit || b.score - a.score);
  return scored.slice(0, limit);
}

function parseArgs(argv) {
  const args = { out: null, limit: null };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--out') {
      args.out = argv[i + 1];
      i += 1;
    } else if (token === '--limit') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) args.limit = Math.floor(n);
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const defaultOut = path.join(process.cwd(), 'exports', `category_review_root_mismatches_${stamp}.csv`);
  const outPath = args.out
    ? (path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out))
    : defaultOut;
  ensureDir(path.dirname(outPath));

  const categories = loadEbayCategories();
  const products = await getAllProductsForTenant(TENANT_ID);
  const list = args.limit ? products.slice(0, args.limit) : products;

  const rows = [];
  for (const p of list) {
    const currentId = safeString(p?.details?.categoryId);
    const currentCanon = currentId ? canonicalBreadcrumb(categories, currentId) : '';
    const currentRoot = currentCanon ? rootOfBreadcrumb(currentCanon) : '';

    // derive tokens from product signals (NOT from current category)
    const produktart = pickProduktart(p);
    const seed = [
      safeString(p?.identification?.brand),
      safeString(p?.identification?.name),
      produktart,
    ]
      .filter(Boolean)
      .join(' ');
    const tokens = Array.from(new Set(tokenize(seed))).slice(0, 10);
    if (tokens.length < 2) continue;

    const best = buildCandidates(categories, tokens, { limit: 3 });
    if (!best.length) continue;

    const best1 = best[0];
    const bestRoot = rootOfBreadcrumb(best1.breadcrumb);

    // Flag when:
    // - we have a current leaf category AND best suggestion points to a different root, with decent token hits
    // - OR current is empty/too broad
    const currentOk = Boolean(currentCanon && currentCanon.includes('>'));
    const rootMismatch = currentOk && currentRoot && bestRoot && currentRoot !== bestRoot;
    const lowConfidenceCurrent = !currentOk;

    // Require evidence: best hits >= 3 tokens OR strong mismatch in Auto root
    const strong = best1.hit >= 3;
    const autoMismatch =
      currentOk &&
      normalizeText(currentRoot).includes('auto') &&
      !normalizeText(bestRoot).includes('auto') &&
      best1.hit >= 2;

    if (!(lowConfidenceCurrent || (rootMismatch && (strong || autoMismatch)))) {
      continue;
    }

    // Prefill Target fields only when best is strong enough and not extremely generic.
    const prefill = best1.hit >= 4;

    rows.push({
      sku: pickSku(p),
      docId: safeString(p?.id),
      title: safeString(p?.identification?.name),
      brand: safeString(p?.identification?.brand),
      produktart,
      currentCategoryId: currentId,
      currentBreadcrumb: currentCanon || safeString(p?.identification?.category),
      currentRoot: currentRoot || rootOfBreadcrumb(safeString(p?.identification?.category)),
      suggested1Id: best1.id,
      suggested1Breadcrumb: best1.breadcrumb,
      suggested1Hit: best1.hit,
      suggested2Id: best[1]?.id || '',
      suggested2Breadcrumb: best[1]?.breadcrumb || '',
      suggested2Hit: best[1]?.hit || '',
      suggested3Id: best[2]?.id || '',
      suggested3Breadcrumb: best[2]?.breadcrumb || '',
      suggested3Hit: best[2]?.hit || '',
      targetCategoryId: prefill ? best1.id : '',
      targetCategoryBreadcrumb: prefill ? best1.breadcrumb : '',
      notes: rootMismatch ? 'root_mismatch' : !currentOk ? 'missing_or_broad' : 'mismatch',
    });
  }

  // Stable ordering
  rows.sort((a, b) => {
    const n = String(a.notes).localeCompare(String(b.notes));
    if (n) return n;
    const r = String(a.currentRoot).localeCompare(String(b.currentRoot));
    if (r) return r;
    return String(a.sku).localeCompare(String(b.sku));
  });

  const headers = [
    'SKU',
    'DocId',
    'Titel',
    'Brand',
    'Produktart',
    'CurrentCategoryId',
    'CurrentBreadcrumb',
    'CurrentRoot',
    'Suggested1Id',
    'Suggested1Breadcrumb',
    'Suggested1Hit',
    'Suggested2Id',
    'Suggested2Breadcrumb',
    'Suggested2Hit',
    'Suggested3Id',
    'Suggested3Breadcrumb',
    'Suggested3Hit',
    'TargetCategoryBreadcrumb',
    'TargetCategoryId',
    'Notes',
  ];

  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.sku,
        r.docId,
        r.title,
        r.brand,
        r.produktart,
        r.currentCategoryId,
        r.currentBreadcrumb,
        r.currentRoot,
        r.suggested1Id,
        r.suggested1Breadcrumb,
        r.suggested1Hit,
        r.suggested2Id,
        r.suggested2Breadcrumb,
        r.suggested2Hit,
        r.suggested3Id,
        r.suggested3Breadcrumb,
        r.suggested3Hit,
        r.targetCategoryBreadcrumb,
        r.targetCategoryId,
        r.notes,
      ].map(csvEscape).join(',')
    );
  }
  fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`[category-root-mismatch-review] exported=${rows.length} -> ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

