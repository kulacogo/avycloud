/* eslint-disable no-console */
/**
 * Export products as a Channable-mappable CSV.
 *
 * What "Channable-ready" means here:
 * - Columns follow the user's requested layout (you can map them in Channable on import)
 * - Attributes are flattened into separate columns (union of all attribute keys)
 * - Attribute values are de-duplicated per product/key (best-effort)
 * - Only N image URL columns are exported (default: 5)
 * - Includes Location (BIN) + Stock (quantity)
 *
 * Defaults:
 * - Only exports products that have a BIN/Location AND Stock >= 1 (typical "sellable inventory" feed)
 *
 * Usage:
 *   node backend/scripts/export-products-channable-ready-csv.js \
 *     --out exports/products_channable_ready.csv \
 *     --delimiter "," \
 *     --maxImages 5 \
 *     --minStock 1 \
 *     --requireLocation true \
 *     --tenant avycloud
 *
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 */

const fs = require('fs');
const path = require('path');
const { getAllProductsForTenant } = require('../lib/firestore');
const { isValidGtin, normalizeDigits, getGtinType } = require('../lib/gtin');
const XLSX = require('xlsx');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeNewlines(value) {
  return String(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function csvEscape(value, delimiter) {
  if (value === null || value === undefined) return '';
  const str = normalizeNewlines(value);
  // Quote if contains delimiter/quote/newline or leading/trailing spaces (Excel safety)
  const needsQuote =
    str.includes('"') || str.includes('\n') || str.includes('\r') || str.includes(delimiter) || /^\s|\s$/.test(str);
  if (needsQuote) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function parseBool(v, defaultValue) {
  if (v === undefined || v === null) return defaultValue;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'y') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'n') return false;
  return defaultValue;
}

function parseNumber(v, defaultValue) {
  if (v === undefined || v === null) return defaultValue;
  const n = Number(v);
  return Number.isFinite(n) ? n : defaultValue;
}

function parseArgs(argv) {
  const args = {
    out: path.join(process.cwd(), 'exports', 'products_channable_ready.csv'),
    xlsxOut: null,
    delimiter: ',',
    maxImages: 5,
    minStock: 1,
    requireLocation: true,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--out') {
      args.out = argv[i + 1];
      i += 1;
    } else if (t === '--xlsxOut') {
      args.xlsxOut = argv[i + 1];
      i += 1;
    } else if (t === '--delimiter') {
      args.delimiter = argv[i + 1] || ',';
      i += 1;
    } else if (t === '--maxImages') {
      args.maxImages = parseInt(argv[i + 1] || '5', 10);
      i += 1;
    } else if (t === '--minStock') {
      args.minStock = parseNumber(argv[i + 1], 1);
      i += 1;
    } else if (t === '--requireLocation') {
      args.requireLocation = parseBool(argv[i + 1], true);
      i += 1;
    } else if (t === '--tenant') {
      args.tenant = argv[i + 1];
      i += 1;
    }
  }
  args.maxImages = Math.max(0, Math.min(20, Number.isFinite(args.maxImages) ? args.maxImages : 5));
  if (!args.tenant || typeof args.tenant !== 'string' || !args.tenant.trim()) {
    console.warn('[export-products-channable-ready-csv] No --tenant provided, defaulting to "avycloud".');
    args.tenant = 'avycloud';
  }
  return args;
}

function pickSku(product) {
  return safeString(product?.identification?.sku) || safeString(product?.details?.identifiers?.sku) || safeString(product?.id) || '';
}

function pickTitle(product) {
  return safeString(product?.identification?.name) || safeString(product?.details?.title) || '';
}

function pickHighlights(product) {
  const list = Array.isArray(product?.details?.key_features) ? product.details.key_features : [];
  const cleaned = list.map((x) => safeString(x)).filter(Boolean);
  return cleaned.join(' | ');
}

function pickDescription(product) {
  const long = safeString(product?.details?.description);
  const short = safeString(product?.details?.short_description);
  return long || short || '';
}

function pickPriceAmount(product) {
  const lowest = product?.details?.pricing?.lowest_price;
  const amount = lowest?.amount;
  if (typeof amount === 'number' && Number.isFinite(amount) && amount > 0) return amount;
  const legacy = product?.details?.pricing?.price;
  if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy > 0) return legacy;
  return null;
}

function formatPrice(product) {
  const amount = pickPriceAmount(product);
  if (amount === null) return '';
  // Channable usually accepts plain numeric; keep stable with dot decimal.
  return Number(amount).toFixed(2);
}

function sumStorageBins(product) {
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  return bins.reduce((sum, b) => sum + (Number(b?.quantity) || 0), 0);
}

function pickLocation(product) {
  const explicit = safeString(product?.storage?.binCode);
  if (explicit) return explicit;
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  if (!bins.length) return '';
  const sorted = [...bins].sort((a, b) => (Number(b?.quantity) || 0) - (Number(a?.quantity) || 0));
  return safeString(sorted[0]?.code || sorted[0]?.binCode) || '';
}

function pickStock(product) {
  const binsQty = sumStorageBins(product);
  const legacyStorageQty = Number(product?.storage?.quantity) || 0;
  const inventoryPhysical = Number(product?.inventory?.physicalQuantity) || 0;
  const inventoryQty = Number(product?.inventory?.quantity) || 0;
  // Prefer BIN sum when present, but keep a sane fallback.
  const best = Math.max(binsQty, legacyStorageQty, inventoryPhysical, inventoryQty);
  return Number.isFinite(best) ? Math.max(0, best) : 0;
}

function pickImages(product, maxImages) {
  const images = Array.isArray(product?.details?.images) ? product.details.images : [];
  const urls = images
    .map((img) => safeString(img?.url_or_base64))
    .filter((u) => u && (u.startsWith('http://') || u.startsWith('https://')));
  return urls.slice(0, maxImages);
}

function collectGtinCandidates(product) {
  const ids = product?.details?.identifiers || {};
  const candidates = []
    .concat([ids.ean, ids.gtin, ids.upc])
    .concat(Array.isArray(product?.identification?.barcodes) ? product.identification.barcodes : [])
    .filter(Boolean)
    .map((v) => normalizeDigits(String(v)))
    .filter(Boolean);
  // De-dupe while keeping order
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    if (!seen.has(c)) {
      seen.add(c);
      unique.push(c);
    }
  }
  return unique;
}

function pickEanAndGtin(product) {
  const candidates = collectGtinCandidates(product).filter((c) => isValidGtin(c));
  let ean = '';
  let gtin = '';
  for (const c of candidates) {
    const t = getGtinType(c);
    if (!ean && t === 'ean13') ean = c;
    if (!gtin && t === 'gtin14') gtin = c;
    if (ean && gtin) break;
  }
  // Fallback: if only one valid code exists, put it into EAN if it's 13, otherwise GTIN if 14.
  if (!ean && !gtin && candidates.length) {
    const c = candidates[0];
    const t = getGtinType(c);
    if (t === 'ean13') ean = c;
    if (t === 'gtin14') gtin = c;
  }
  return { ean, gtin };
}

function normalizeAttrKey(key) {
  const s = safeString(key);
  if (!s) return '';
  // collapse whitespace for header stability
  return s.replace(/\s+/g, ' ').trim();
}

function stringifyAttrValue(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    const parts = value.map((v) => safeString(v)).filter(Boolean);
    const uniq = Array.from(new Set(parts));
    return uniq.join(' | ');
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return safeString(value);
}

function dedupeValueString(value) {
  // Best-effort dedupe for multi-value strings separated by common delimiters.
  const raw = safeString(value);
  if (!raw) return '';
  const parts = raw
    .split(/\s*\|\s*|\s*;\s*|\s*,\s*|\s*\n\s*/g)
    .map((p) => safeString(p))
    .filter(Boolean);
  if (parts.length <= 1) return raw;
  const uniq = Array.from(new Set(parts));
  return uniq.join(' | ');
}

function extractAttributes(product) {
  const attrs = product?.details?.attributes && typeof product.details.attributes === 'object' ? product.details.attributes : {};
  const keyMap = new Map(); // lowerKey -> canonicalKey
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    const key = normalizeAttrKey(k);
    if (!key) continue;
    const lower = key.toLowerCase();
    const canonical = keyMap.get(lower) || key;
    keyMap.set(lower, canonical);
    const valueStr = dedupeValueString(stringifyAttrValue(v));
    if (!valueStr) continue;
    // If multiple sources map to same canonical key, merge values (deduped)
    if (out[canonical]) {
      out[canonical] = dedupeValueString(`${out[canonical]} | ${valueStr}`);
    } else {
      out[canonical] = valueStr;
    }
  }
  return out;
}

function buildAttributeHeaderKeys(products) {
  const deny = new Set(
    [
      'titel',
      'title',
      'sku',
      'ean',
      'gtin',
      'highlights',
      'description',
      'beschreibung',
      'price',
      'preis',
      'image url 1',
      'image url 2',
      'image url 3',
      'image url 4',
      'image url 5',
      'location',
      'stock',
      'menge',
    ].map((s) => s.toLowerCase())
  );
  const set = new Map(); // lower -> canonical
  for (const p of products) {
    const attrs = extractAttributes(p);
    for (const key of Object.keys(attrs)) {
      const lower = key.toLowerCase();
      if (deny.has(lower)) continue;
      if (!set.has(lower)) set.set(lower, key);
    }
  }
  return Array.from(set.values()).sort((a, b) => a.localeCompare(b, 'de'));
}

async function main() {
  const args = parseArgs(process.argv);
  const outPath = path.isAbsolute(args.out) ? args.out : path.join(process.cwd(), args.out);
  ensureDir(path.dirname(outPath));
  const xlsxOutPath = args.xlsxOut
    ? path.isAbsolute(args.xlsxOut)
      ? args.xlsxOut
      : path.join(process.cwd(), args.xlsxOut)
    : null;
  if (xlsxOutPath) ensureDir(path.dirname(xlsxOutPath));

  const productsAll = await getAllProductsForTenant(args.tenant);
  const productsFiltered = productsAll.filter((p) => {
    const stock = pickStock(p);
    const loc = pickLocation(p);
    if (args.requireLocation && !loc) return false;
    if (stock < args.minStock) return false;
    return true;
  });

  const attributeKeys = buildAttributeHeaderKeys(productsFiltered);

  const fixedHeaders = [
    'Titel',
    'SKU',
    'EAN',
    'GTIN',
    'Highlights',
    'Description',
    ...attributeKeys,
    'price',
    ...Array.from({ length: args.maxImages }, (_, i) => `image url ${i + 1}`),
    'Location',
    'Stock',
  ];

  const lines = [];
  lines.push(fixedHeaders.map((h) => csvEscape(h, args.delimiter)).join(args.delimiter));
  const aoa = [fixedHeaders];

  for (const product of productsFiltered) {
    const { ean, gtin } = pickEanAndGtin(product);
    const attrs = extractAttributes(product);
    const images = pickImages(product, args.maxImages);
    const row = [
      pickTitle(product),
      pickSku(product),
      ean,
      gtin,
      pickHighlights(product),
      pickDescription(product),
      ...attributeKeys.map((k) => attrs[k] || ''),
      formatPrice(product),
      ...Array.from({ length: args.maxImages }, (_, i) => images[i] || ''),
      pickLocation(product),
      pickStock(product),
    ];
    lines.push(row.map((v) => csvEscape(v, args.delimiter)).join(args.delimiter));
    aoa.push(row);
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf8');

  if (xlsxOutPath) {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, 'Products');
    XLSX.writeFile(wb, xlsxOutPath);
  }

  console.log(
    `[export] channable_ready rows=${productsFiltered.length} attrs=${attributeKeys.length} maxImages=${args.maxImages} delimiter="${args.delimiter}" -> ${outPath}${
      xlsxOutPath ? ` | ${xlsxOutPath}` : ''
    }`
  );
}

main().catch((err) => {
  console.error('Export failed:', err);
  process.exit(1);
});

