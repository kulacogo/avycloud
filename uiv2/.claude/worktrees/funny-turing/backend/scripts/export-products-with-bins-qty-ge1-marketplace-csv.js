/* eslint-disable no-console */
/**
 * Export products that have a BIN association with total quantity >= 1 as a marketplace-friendly CSV.
 *
 * Input:
 * - Defaults to reading `exports/products_with_bins_qty_ge1.json` (already filtered by hasBin + minQty=1).
 *
 * Output columns (requested):
 * - Titel
 * - EAN oder GTIN
 * - SKU
 * - Kategorie
 * - Highlights
 * - Image URLs (all, separate columns)
 * - Beschreibung
 * - Attribute
 * - Parameter (identifiers/gpsr/attributes_extra/categoryId as JSON)
 * - BIN
 * - Menge
 * - Preis
 *
 * Usage:
 *   node backend/scripts/export-products-with-bins-qty-ge1-marketplace-csv.js \
 *     --in exports/products_with_bins_qty_ge1.json \
 *     --out exports/products_with_bins_qty_ge1_marketplace.csv
 */

const fs = require('fs');
const path = require('path');
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

function stableJson(obj) {
  if (!obj || typeof obj !== 'object') return JSON.stringify(obj ?? null);
  if (Array.isArray(obj)) return JSON.stringify(obj);
  const entries = Object.entries(obj).sort(([a], [b]) => String(a).localeCompare(String(b)));
  const normalized = {};
  for (const [k, v] of entries) normalized[k] = v;
  return JSON.stringify(normalized);
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
  if (cat && cat.includes('>')) return cat;
  const catId = safeString(product?.details?.categoryId);
  if (catId) {
    const resolved = findEbayCategory(catId);
    const breadcrumb = resolved?.breadcrumb ? String(resolved.breadcrumb) : '';
    if (breadcrumb && breadcrumb.includes('>')) return breadcrumb;
  }
  return cat || '';
}

function formatPrice(product) {
  const lowest = product?.details?.pricing?.lowest_price;
  const amount = lowest?.amount;
  const currency = safeString(lowest?.currency) || 'EUR';
  if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) {
    return `${amount} ${currency}`;
  }
  // Sometimes legacy fields exist
  const legacy = product?.details?.pricing?.price;
  if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy > 0) {
    return `${legacy} ${currency}`;
  }
  return '';
}

function sumStorageBins(product) {
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  return bins.reduce((sum, b) => sum + (Number(b?.quantity) || 0), 0);
}

function pickPrimaryBin(product) {
  const explicit = safeString(product?.storage?.binCode);
  if (explicit) return explicit;
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  if (!bins.length) return '';
  const sorted = [...bins].sort((a, b) => (Number(b?.quantity) || 0) - (Number(a?.quantity) || 0));
  return safeString(sorted[0]?.code || sorted[0]?.binCode) || '';
}

function formatBinList(product) {
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  const parts = bins
    .map((b) => {
      const code = safeString(b?.code || b?.binCode);
      const qty = Number(b?.quantity) || 0;
      if (!code || qty <= 0) return '';
      return `${code}:${qty}`;
    })
    .filter(Boolean);
  return parts.join(' ; ');
}

function parseArgs(argv) {
  const args = {
    in: path.join(process.cwd(), 'exports', 'products_with_bins_qty_ge1.json'),
    out: path.join(process.cwd(), 'exports', 'products_with_bins_qty_ge1_marketplace.csv'),
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--in') {
      args.in = argv[i + 1];
      i += 1;
    } else if (t === '--out') {
      args.out = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const inPath = path.isAbsolute(args.in) ? args.in : path.join(process.cwd(), args.in);
  const outPath = path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out);
  ensureDir(path.dirname(outPath));

  const raw = fs.readFileSync(inPath, 'utf8');
  const json = JSON.parse(raw);
  const products = Array.isArray(json?.products) ? json.products : [];

  // Filter defensively: only with BIN quantity >= 1
  const filtered = products.filter((p) => sumStorageBins(p) >= 1);

  // Determine max number of images to output as separate columns
  let maxImages = 0;
  for (const p of filtered) {
    const imgs = Array.isArray(p?.details?.images) ? p.details.images : [];
    if (imgs.length > maxImages) maxImages = imgs.length;
  }
  // Cap to keep CSV width sane; still include all via Images_json
  maxImages = Math.min(Math.max(maxImages, 0), 20);

  const headers = [
    'Titel',
    'EAN/GTIN',
    'SKU',
    'Kategorie',
    'Highlights',
    ...Array.from({ length: maxImages }, (_, i) => `Image URL ${i + 1}`),
    'Beschreibung',
    'Attribute_json',
    'Parameter_json',
    'BIN',
    'Menge',
    'BINs',
    'Preis',
  ];

  const lines = [];
  lines.push(headers.join(','));

  for (const product of filtered) {
    const images = Array.isArray(product?.details?.images) ? product.details.images : [];
    const imageUrls = images
      .map((img) => safeString(img?.url_or_base64))
      .filter(Boolean)
      .map((u) => (u.startsWith('http://') || u.startsWith('https://') ? u : '')); // only real URLs

    const attrs =
      product?.details?.attributes && typeof product.details.attributes === 'object'
        ? product.details.attributes
        : {};

    const params = {
      identifiers: product?.details?.identifiers || {},
      gpsr: product?.details?.gpsr || null,
      attributes_extra:
        product?.details?.attributes_extra && typeof product.details.attributes_extra === 'object'
          ? product.details.attributes_extra
          : null,
      categoryId: safeString(product?.details?.categoryId) || null,
    };

    const qty = sumStorageBins(product);

    const row = [
      safeString(product?.identification?.name),
      pickBarcode(product),
      pickSku(product),
      pickCategory(product),
      formatHighlights(product),
      ...Array.from({ length: maxImages }, (_, i) => imageUrls[i] || ''),
      pickDescription(product),
      stableJson(attrs),
      stableJson(params),
      pickPrimaryBin(product),
      qty,
      formatBinList(product),
      formatPrice(product),
    ];
    lines.push(row.map(csvEscape).join(','));
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(
    `[export] products_with_bins_qty_ge1_marketplace rows=${filtered.length} maxImages=${maxImages} -> ${outPath}`
  );
}

main().catch((err) => {
  console.error('Export failed:', err);
  process.exit(1);
});

