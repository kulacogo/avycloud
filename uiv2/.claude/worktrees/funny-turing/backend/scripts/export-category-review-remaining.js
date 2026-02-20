/* eslint-disable no-console */
/**
 * Export a review CSV for remaining category issues:
 * - category_id_missing
 * - category_text_not_breadcrumb
 * - category_too_broad
 *
 * The CSV is meant for evidence-based suggestion (no Firestore writes).
 *
 * Usage:
 *   node backend/scripts/export-category-review-remaining.js
 *   node backend/scripts/export-category-review-remaining.js --out exports/category_review_remaining.csv
 */

const fs = require('fs');
const path = require('path');
const { getAllProducts } = require('../lib/firestore');
const { findEbayCategory } = require('../lib/ebay-taxonomy');

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
  const defaultOut = path.join(process.cwd(), 'exports', `category_review_remaining_${stamp}.csv`);
  const outPath = args.out
    ? (path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out))
    : defaultOut;
  ensureDir(path.dirname(outPath));

  const products = await getAllProducts();

  const rows = [];
  for (const p of products) {
    const categoryId = safeString(p?.details?.categoryId);
    const categoryText = safeString(p?.identification?.category);

    const flags = [];
    if (!categoryId) flags.push('category_id_missing');
    else {
      const resolved = findEbayCategory(categoryId);
      const breadcrumb = safeString(resolved?.breadcrumb);
      if (!breadcrumb) flags.push('category_id_unknown');
      else if (!breadcrumb.includes('>')) flags.push('category_too_broad');
    }
    if (categoryText && !categoryText.includes('>')) flags.push('category_text_not_breadcrumb');

    const shouldInclude =
      flags.includes('category_id_missing') ||
      flags.includes('category_too_broad') ||
      flags.includes('category_text_not_breadcrumb');
    if (!shouldInclude) continue;

    const resolved = categoryId ? findEbayCategory(categoryId) : null;
    const breadcrumb = safeString(resolved?.breadcrumb);
    const root = breadcrumb ? rootOfBreadcrumb(breadcrumb) : '';

    rows.push({
      sku: pickSku(p),
      docId: safeString(p?.id),
      title: safeString(p?.identification?.name),
      brand: safeString(p?.identification?.brand),
      produktart: pickProduktart(p),
      currentCategoryId: categoryId,
      currentBreadcrumb: breadcrumb || categoryText,
      currentRoot: root || rootOfBreadcrumb(categoryText),
      targetCategoryBreadcrumb: '',
      targetCategoryId: '',
      notes: flags.join('|'),
    });
  }

  // Stable ordering: notes -> root -> sku
  rows.sort((a, b) => {
    const n = a.notes.localeCompare(b.notes);
    if (n) return n;
    const r = a.currentRoot.localeCompare(b.currentRoot);
    if (r) return r;
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
        r.currentCategoryId,
        r.currentBreadcrumb,
        r.currentRoot,
        r.targetCategoryBreadcrumb,
        r.targetCategoryId,
        r.notes,
      ].map(csvEscape).join(',')
    );
  }

  fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`[category-review-remaining] exported=${rows.length} -> ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


