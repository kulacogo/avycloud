/* eslint-disable no-console */
/**
 * Export Firestore `products` as a clean CSV with stable quoting.
 *
 * Output columns (as requested):
 * - Titel
 * - Brand
 * - Kategorie
 * - SKU
 * - Barcode (EAN/GTIN)
 * - Highlights
 * - Description
 * - Attributes
 * - Price
 * - BIN
 * - Quantity
 *
 * Usage:
 *   node backend/scripts/export-products-csv.js --out exports/products_export.csv
 *
 * Notes:
 * - Uses Application Default Credentials (ADC) via @google-cloud/firestore.
 * - Attributes are exported as JSON in a single cell to keep CSV reliably parseable.
 */

const fs = require('fs');
const path = require('path');
const { getAllProducts } = require('../lib/firestore');
const { getProductBinSummaryMap } = require('../lib/warehouse');
const { findEbayCategory } = require('../lib/ebay-taxonomy');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeNewlines(value) {
  return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = normalizeNewlines(value);
  // Quote if contains delimiter/quote/newline or leading/trailing spaces (Excel safety)
  if (/[",\n]/.test(str) || /^\s|\s$/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
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
  const ean = safeString(product?.details?.identifiers?.ean);
  const gtin = safeString(product?.details?.identifiers?.gtin);
  if (ean) return ean;
  if (gtin) return gtin;
  const barcodes = Array.isArray(product?.identification?.barcodes)
    ? product.identification.barcodes.map((b) => safeString(b)).filter(Boolean)
    : [];
  return barcodes[0] || '';
}

function stableJson(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return JSON.stringify(obj ?? null);
  }
  const entries = Object.entries(obj).sort(([a], [b]) => String(a).localeCompare(String(b)));
  const normalized = {};
  for (const [k, v] of entries) {
    normalized[k] = v;
  }
  return JSON.stringify(normalized);
}

function formatPrice(product) {
  const lowest = product?.details?.pricing?.lowest_price;
  const amount = lowest?.amount;
  const currency = safeString(lowest?.currency) || 'EUR';
  if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) {
    // Keep dot-decimal for CSV portability
    return `${amount} ${currency}`;
  }
  return '';
}

function sumStorageBins(product) {
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  return bins.reduce((sum, b) => sum + (Number(b?.quantity) || 0), 0);
}

function pickQuantity(product, binSummary) {
  const invQty = product?.inventory?.quantity;
  if (typeof invQty === 'number' && Number.isFinite(invQty) && invQty >= 0) return invQty;
  const sumBins = binSummary?.totalQuantity;
  if (typeof sumBins === 'number' && Number.isFinite(sumBins) && sumBins >= 0) return sumBins;
  const fallback = sumStorageBins(product);
  return fallback || 0;
}

function pickPrimaryBin(product, binSummary) {
  const explicit = safeString(product?.storage?.binCode);
  if (explicit) return explicit;
  const bins = Array.isArray(binSummary?.bins) ? binSummary.bins : [];
  if (!bins.length) return '';
  const sorted = [...bins].sort((a, b) => (Number(b?.quantity) || 0) - (Number(a?.quantity) || 0));
  return safeString(sorted[0]?.code) || '';
}

function formatHighlights(product) {
  const list = Array.isArray(product?.details?.key_features) ? product.details.key_features : [];
  const cleaned = list.map((x) => safeString(x)).filter(Boolean);
  return cleaned.join(' | ');
}

function pickDescription(product) {
  const long = safeString(product?.details?.description);
  const short = safeString(product?.details?.short_description);
  return long || short || '';
}

function pickCategory(product) {
  const cat = safeString(product?.identification?.category);
  // Prefer full breadcrumb paths in exports. Leaf-only categories are ambiguous and should not be emitted as-is.
  if (cat && cat.includes('>')) return cat;
  const catId = safeString(product?.details?.categoryId);
  if (catId) {
    const resolved = findEbayCategory(catId);
    const breadcrumb = resolved?.breadcrumb ? String(resolved.breadcrumb) : '';
    if (breadcrumb && breadcrumb.includes('>')) return breadcrumb;
  }
  return '';
}

function parseArgs(argv) {
  const args = { out: path.join(process.cwd(), 'exports', 'products_export.csv') };
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
  const outPath = path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out);
  ensureDir(path.dirname(outPath));

  const products = await getAllProducts();
  // Build a robust SKU->productId map for warehouse bin matching.
  const skuToProductId = new Map();
  products.forEach((p) => {
    const pid = safeString(p?.id);
    if (!pid) return;
    const candidates = [
      pid,
      pickSku(p),
      safeString(pickSku(p)).replace(/^sku[-_\s]*/i, ''),
    ].filter(Boolean);
    candidates.forEach((c) => {
      const raw = safeString(c);
      if (!raw) return;
      skuToProductId.set(raw, pid);
      skuToProductId.set(raw.toLowerCase(), pid);
    });
  });

  const productIds = products.map((p) => safeString(p?.id)).filter(Boolean);
  const binSummaryMap = await getProductBinSummaryMap(productIds, skuToProductId);

  const headers = [
    'Titel',
    'Brand',
    'Kategorie',
    'SKU',
    'Barcode (EAN/GTIN)',
    'Highlights',
    'Description',
    'Attributes',
    'Price',
    'BIN',
    'Quantity',
  ];

  const lines = [];
  lines.push(headers.join(','));

  for (const product of products) {
    const pid = safeString(product?.id);
    const binSummary = pid ? binSummaryMap.get(pid) : null;

    const row = [
      safeString(product?.identification?.name),
      safeString(product?.identification?.brand),
      pickCategory(product),
      pickSku(product),
      pickBarcode(product),
      formatHighlights(product),
      pickDescription(product),
      stableJson(
        product?.details?.attributes && typeof product.details.attributes === 'object'
          ? product.details.attributes
          : {}
      ),
      formatPrice(product),
      pickPrimaryBin(product, binSummary),
      pickQuantity(product, binSummary),
    ];
    lines.push(row.map(csvEscape).join(','));
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`Exported products: ${products.length} -> ${outPath}`);
}

main().catch((err) => {
  console.error('Export failed:', err);
  process.exit(1);
});


