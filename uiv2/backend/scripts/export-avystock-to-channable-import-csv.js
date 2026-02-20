/* eslint-disable no-console */
/**
 * Export AvyCloud/AvyStock Firestore products into a Channable import CSV.
 *
 * Official reference (Channable Help Center):
 * - Requirements for import files
 * - Example shows: delimiter is comma, values between quotes when needed, header row first.
 *
 * This script:
 * - Uses comma as delimiter
 * - Writes a header row
 * - Includes Channable's reference "mandatory" fields (per their table), plus extra fields requested by user
 * - Pulls data strictly from Firestore products (no guessed SKUs/URLs)
 *
 * Usage:
 *   node backend/scripts/export-avystock-to-channable-import-csv.js \
 *     --out exports/avystock_channable_import.csv \
 *     --minStock 1 \
 *     --maxImages 10
 */

const fs = require('fs');
const path = require('path');
const { getAllProducts } = require('../lib/firestore');

const DELIMITER = ',';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function parseArgs(argv) {
  const args = {
    out: path.join(process.cwd(), 'exports', 'avystock_channable_import.csv'),
    minStock: 1,
    maxImages: 10,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--out') {
      args.out = argv[i + 1];
      i += 1;
    } else if (t === '--minStock') {
      args.minStock = Number(argv[i + 1] || '1');
      i += 1;
    } else if (t === '--maxImages') {
      args.maxImages = parseInt(argv[i + 1] || '10', 10);
      i += 1;
    }
  }
  if (!Number.isFinite(args.minStock)) args.minStock = 1;
  args.maxImages = Math.max(1, Math.min(50, Number.isFinite(args.maxImages) ? args.maxImages : 10));
  return args;
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
  return safeString(product?.identification?.sku) || safeString(product?.details?.identifiers?.sku) || '';
}

function pickId(product) {
  // Channable reference: unique id, preferably incl. variant info. We use SKU as stable unique key.
  const sku = pickSku(product);
  return sku || safeString(product?.id) || '';
}

function pickTitle(product) {
  return safeString(product?.identification?.name) || '';
}

function pickBrand(product) {
  return safeString(product?.identification?.brand) || safeString(product?.details?.attributes?.Marke) || '';
}

function pickProductTypeBreadcrumb(product) {
  // Channable reference field: product_type = breadcrumb e.g. men/sweaters
  // We use our existing breadcrumb string (">" separated). Users can remap later.
  return safeString(product?.identification?.category) || '';
}

function pickDescription(product) {
  return safeString(product?.details?.description) || safeString(product?.details?.short_description) || '';
}

function pickHighlights(product) {
  const list = Array.isArray(product?.details?.key_features) ? product.details.key_features : [];
  const cleaned = list.map((x) => safeString(x)).filter(Boolean);
  return cleaned.join(' | ');
}

function pickPrice(product) {
  const amount = product?.details?.pricing?.lowest_price?.amount;
  if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) return Number(amount).toFixed(2);
  const legacy = product?.details?.pricing?.price;
  if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy > 0) return Number(legacy).toFixed(2);
  return '';
}

function pickSalePrice(product) {
  // If you don't have discounts, keep sale_price equal to price (safe default).
  return pickPrice(product);
}

function sumStock(product) {
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  const binSum = bins.reduce((s, b) => s + (Number(b?.quantity) || 0), 0);
  if (binSum > 0) return binSum;
  const physical = Number(product?.inventory?.physicalQuantity) || 0;
  if (physical > 0) return physical;
  const qty = Number(product?.inventory?.quantity) || 0;
  if (qty > 0) return qty;
  const legacyStorage = Number(product?.storage?.quantity) || 0;
  return legacyStorage > 0 ? legacyStorage : 0;
}

function pickAvailability(stock) {
  return stock > 0 ? 'in stock' : 'out of stock';
}

function pickLocation(product) {
  const explicit = safeString(product?.storage?.binCode);
  if (explicit) return explicit;
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  if (!bins.length) return '';
  const sorted = [...bins].sort((a, b) => (Number(b?.quantity) || 0) - (Number(a?.quantity) || 0));
  return safeString(sorted[0]?.code || sorted[0]?.binCode) || '';
}

function pickImages(product, maxImages) {
  const imgs = Array.isArray(product?.details?.images) ? product.details.images : [];
  const urls = imgs
    .map((img) => safeString(img?.url_or_base64))
    .filter((u) => u && (u.startsWith('http://') || u.startsWith('https://')));
  const seen = new Set();
  const out = [];
  for (const u of urls) {
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= maxImages) break;
  }
  return out;
}

function pickLink(product) {
  // Channable reference table marks `link` as mandatory, but AvyCloud may not have a canonical PDP.
  // We therefore only use URLs that already exist in the product data (no guessing):
  // 1) first lowest price source URL
  // 2) first image URL
  const sources = product?.details?.pricing?.lowest_price?.sources;
  if (Array.isArray(sources)) {
    for (const s of sources) {
      const u = safeString(s?.url);
      if (u && (u.startsWith('http://') || u.startsWith('https://'))) return u;
    }
  }
  const imgs = pickImages(product, 1);
  return imgs[0] || '';
}

function pickGtinEan(product) {
  const ids = product?.details?.identifiers || {};
  return safeString(ids.ean) || safeString(ids.gtin) || safeString(ids.upc) || '';
}

function pickMpn(product) {
  const ids = product?.details?.identifiers || {};
  const attrs = product?.details?.attributes || {};
  return safeString(ids.mpn) || safeString(attrs.Herstellernummer) || safeString(attrs.MPN) || '';
}

function pickSize(product) {
  const attrs = product?.details?.attributes || {};
  return (
    safeString(attrs['EU-Schuhgröße']) ||
    safeString(attrs['US-Schuhgröße']) ||
    safeString(attrs['UK-Schuhgröße']) ||
    safeString(attrs.Größe) ||
    safeString(attrs.Size) ||
    ''
  );
}

function pickColor(product) {
  const attrs = product?.details?.attributes || {};
  return safeString(attrs.Farbe) || safeString(attrs.Color) || '';
}

function pickMaterial(product) {
  const attrs = product?.details?.attributes || {};
  return safeString(attrs.Material) || safeString(attrs.Obermaterial) || '';
}

function pickCondition(product) {
  const attrs = product?.details?.attributes || {};
  return safeString(attrs.Zustand) || 'new';
}

function pickKTyp(product) {
  const attrs = product?.details?.attributes || {};
  const key = Object.keys(attrs || {}).find((k) => {
    const lower = String(k || '').trim().toLowerCase();
    return lower === 'k-typ' || lower === 'ktyp' || lower === 'k typ';
  });
  return key ? safeString(attrs[key]) : '';
}

async function main() {
  const args = parseArgs(process.argv);
  const outPath = path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out);
  ensureDir(path.dirname(outPath));

  const products = await getAllProducts();

  // Channable reference fields (per table) + user requested extras.
  // Note: the Help Center article explicitly says this is a reference and channels may require different fields.
  const headers = [
    // Reference mandatory/recommended fields
    'id',
    'title',
    'description',
    'brand',
    'product_type',
    'price',
    'sale_price',
    'availability',
    'link',
    'image_link',
    'additional_image_link',
    'gtin/ean',
    'mpn',
    'color',
    'size',
    'material',
    'condition',
    'stock',
    // AvyCloud requested extras
    'category', // AvyCloud breadcrumb
    'location',
    'quantity',
    'highlights',
    'k_typ',
    'attributes_json',
    'images_json',
  ];

  const lines = [];
  lines.push(headers.map(csvEscape).join(DELIMITER));

  const stats = {
    total: products.length,
    exported: 0,
    skipped_missing_id: 0,
    skipped_below_min_stock: 0,
  };

  for (const p of products) {
    const stock = sumStock(p);
    if (stock < args.minStock) {
      stats.skipped_below_min_stock += 1;
      continue;
    }

    const id = pickId(p);
    if (!id) {
      stats.skipped_missing_id += 1;
      continue;
    }

    const title = pickTitle(p);
    const brand = pickBrand(p);
    const description = pickDescription(p);
    const productType = pickProductTypeBreadcrumb(p);
    const price = pickPrice(p);
    const salePrice = pickSalePrice(p);
    const availability = pickAvailability(stock);
    const link = pickLink(p);
    const images = pickImages(p, args.maxImages);
    const imageLink = images[0] || '';
    const additionalImageLink = images.length > 1 ? images.slice(1).join(',') : '';
    const gtinEan = pickGtinEan(p);
    const mpn = pickMpn(p);
    const color = pickColor(p);
    const size = pickSize(p);
    const material = pickMaterial(p);
    const condition = pickCondition(p);
    const category = safeString(p?.identification?.category) || '';
    const location = pickLocation(p);
    const highlights = pickHighlights(p);
    const kTyp = pickKTyp(p);
    const attrs =
      p?.details?.attributes && typeof p.details.attributes === 'object' ? p.details.attributes : {};

    const row = [
      id,
      title,
      description,
      brand,
      productType,
      price,
      salePrice,
      availability,
      link,
      imageLink,
      additionalImageLink,
      gtinEan,
      mpn,
      color,
      size,
      material,
      condition,
      stock,
      category,
      location,
      stock,
      highlights,
      kTyp,
      stableJson(attrs),
      stableJson(images),
    ];

    lines.push(row.map(csvEscape).join(DELIMITER));
    stats.exported += 1;
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
  console.log(`[channable-export] out=${outPath}`);
  console.log('[channable-export] stats=', JSON.stringify(stats, null, 2));
}

main().catch((err) => {
  console.error('Channable export failed:', err);
  process.exit(1);
});

