/* eslint-disable no-console */
/**
 * Export a review CSV for products whose *canonical* eBay category root looks suspicious.
 *
 * Current suspicious roots:
 * - Sammeln & Seltenes
 * - Antiquitäten & Kunst
 * - Business & Industrie
 *
 * The CSV is meant for a human to quickly review and optionally provide a corrected category.
 * We include empty columns: Target Category Breadcrumb / Target Category ID / Notes.
 *
 * Usage:
 *   node backend/scripts/export-category-review-suspicious-roots.js
 *   node backend/scripts/export-category-review-suspicious-roots.js --out exports/category_review_suspicious_roots.csv
 */

const fs = require('fs');
const path = require('path');
const { getAllProducts } = require('../lib/firestore');

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
    safeString(attrs.Typ) ||
    ''
  );
}

function loadEbayCategories() {
  // Canonical eBay taxonomy (id -> { id, name, breadcrumb })
  // NOTE: This is the only source we trust for canonical breadcrumbs.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require('../ebay-data/categories.json');
}

function canonicalBreadcrumb(categories, id) {
  const key = safeString(id);
  if (!key) return '';
  return safeString(categories?.[key]?.breadcrumb);
}

function rootOfBreadcrumb(breadcrumb) {
  const seg = safeString(breadcrumb)
    .split('>')
    .map((s) => s.trim())
    .filter(Boolean);
  return seg[0] || '';
}

function parseArgs(argv) {
  const args = { out: null };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--out') {
      args.out = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const stamp = nowStamp();
  const defaultOut = path.join(process.cwd(), 'exports', `category_review_suspicious_roots_${stamp}.csv`);
  const outPath = args.out
    ? (path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out))
    : defaultOut;
  ensureDir(path.dirname(outPath));

  const categories = loadEbayCategories();
  const suspiciousRoots = new Set(['Sammeln & Seltenes', 'Antiquitäten & Kunst', 'Business & Industrie']);

  const products = await getAllProducts();

  const rows = [];
  for (const p of products) {
    const categoryId = safeString(p?.details?.categoryId);
    if (!categoryId) continue;
    const breadcrumb = canonicalBreadcrumb(categories, categoryId);
    if (!breadcrumb || !breadcrumb.includes('>')) continue;
    const root = rootOfBreadcrumb(breadcrumb);
    if (!suspiciousRoots.has(root)) continue;

    rows.push({
      sku: pickSku(p),
      docId: safeString(p?.id),
      title: safeString(p?.identification?.name),
      brand: safeString(p?.identification?.brand),
      produktart: pickProduktart(p),
      categoryId,
      breadcrumb,
      root,
      // review inputs (to be filled by human)
      targetCategoryBreadcrumb: '',
      targetCategoryId: '',
      notes: '',
    });
  }

  // Stable ordering: root -> breadcrumb -> sku
  rows.sort((a, b) => {
    const r = a.root.localeCompare(b.root);
    if (r) return r;
    const c = a.breadcrumb.localeCompare(b.breadcrumb);
    if (c) return c;
    return a.sku.localeCompare(b.sku);
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
    'TargetCategoryBreadcrumb',
    'TargetCategoryId',
    'Notes',
  ];

  const lines = [];
  lines.push(headers.join(','));
  for (const r of rows) {
    lines.push(
      [
        r.sku,
        r.docId,
        r.title,
        r.brand,
        r.produktart,
        r.categoryId,
        r.breadcrumb,
        r.root,
        r.targetCategoryBreadcrumb,
        r.targetCategoryId,
        r.notes,
      ].map(csvEscape).join(',')
    );
  }

  fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`[category-review] exported=${rows.length} -> ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


