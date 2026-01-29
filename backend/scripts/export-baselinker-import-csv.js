/**
 * Export AvyCloud products into a BaseLinker-import-ready CSV.
 *
 * Important (BaseLinker import behavior):
 * - BaseLinker allows mapping arbitrary CSV columns to fields in the UI.
 * - To UPDATE existing products (not create), include the BaseLinker inventory product_id
 *   and use it as the "Main column (Association)" during import.
 *
 * This script exports:
 * - baselinker_product_id (if resolvable)
 * - inventory_id
 * - avycloud_product_id
 * - sku / ean / mpn
 * - title / description
 * - quantity / price
 * - category_path
 *
 * It also splits output into <= ~1.8MB chunks to stay safely under BaseLinker’s 2MB import limit.
 */

const fs = require('fs');
const path = require('path');

const { getAllProducts, getSkuIndexEntry } = require('../lib/firestore');
const { getProductBinSummaryMap } = require('../lib/warehouse');

const DEFAULT_OUT_DIR = path.join(process.cwd(), 'exports', 'baselinker-import');

const safeString = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const safeNumber = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

// Match backend/index.js semantics (used by /api/products enrichment)
const normalizeIdentityKey = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized.toLowerCase();
};

const buildSkuToProductIdMap = (products = []) => {
  const map = new Map();
  products.forEach((product) => {
    if (!product || !product.id) return;
    const productId = String(product.id);
    const addKey = (value) => {
      const key = normalizeIdentityKey(value);
      if (key) {
        map.set(key, productId);
        const trimmed = key.replace(/^sku[-_\\s]*/, '');
        if (trimmed && !map.has(trimmed)) {
          map.set(trimmed, productId);
        }
      }
    };
    addKey(productId);
    addKey(product.identification?.sku);
    addKey(product.details?.identifiers?.sku);
    addKey(product.details?.identifiers?.ean);
    addKey(product.details?.identifiers?.gtin);
    addKey(product.details?.identifiers?.upc);
  });
  return map;
};

const enrichProductsWithBinSummaries = async (products = []) => {
  if (!Array.isArray(products) || products.length === 0) return products;
  const productIds = products
    .map((product) => (product?.id ? String(product.id) : null))
    .filter(Boolean);
  if (!productIds.length) return products;

  const skuMap = buildSkuToProductIdMap(products);
  const summaryMap = await getProductBinSummaryMap(productIds, skuMap);

  return products.map((product) => {
    const key = product?.id ? String(product.id) : null;
    if (!key || !summaryMap.has(key)) {
      return product;
    }
    const summary = summaryMap.get(key);
    const mergedInventory = {
      ...(product.inventory || {}),
      quantity: summary.totalQuantity,
      physicalQuantity: summary.totalQuantity,
    };
    return {
      ...product,
      inventory: mergedInventory,
      storageBins: summary.bins,
    };
  });
};

// Match backend/index.js ghost filtering: exclude stub docs that break UI + should not be synced/exported.
function isGhostProduct(product = {}) {
  const identification = product?.identification || {};
  const details = product?.details || {};
  const sku =
    safeString(details?.identifiers?.sku) ||
    safeString(identification?.sku) ||
    '';
  const name = safeString(identification?.name) || safeString(details?.title) || '';

  // Ghost docs are typically created by accidental merges/side-effects and miss core identifiers.
  if (!safeString(product?.id) && !sku) return true;
  if (!sku && !name) return true;
  // Avoid rows that look like a bare inventory-only doc (no identification + no details)
  const hasAnyDetailsKey = details && typeof details === 'object' && Object.keys(details).length > 0;
  const hasAnyIdentificationKey =
    identification && typeof identification === 'object' && Object.keys(identification).length > 0;
  if (!hasAnyDetailsKey && !hasAnyIdentificationKey) return true;
  return false;
}

const normalizeSkuValue = (val) =>
  (val || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^sku[-\s]*/i, '')
    .replace(/\s+/g, '');

const normalizeEanValue = (val) =>
  (val || '')
    .toString()
    .replace(/\D+/g, '')
    .trim();

const buildSkuIndexKey = (type, value) => (value ? `${type}:${value}` : null);

function csvEscape(value) {
  const str = value == null ? '' : String(value);
  // Use semicolon separated CSV (common DE). Always quote if contains delimiter/newline/quote.
  const needsQuote = /[;\n\r"]/g.test(str);
  const escaped = str.replace(/"/g, '""');
  return needsQuote ? `"${escaped}"` : escaped;
}

function toCsvLine(values) {
  return values.map(csvEscape).join(';') + '\n';
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function hasBin(product) {
  const direct = safeString(product?.storage?.binCode);
  if (direct) return true;
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  // Match UI semantics (components/AdminTable.tsx):
  // "BIN zugeordnet" means ANY storage bin assignment exists, even if its quantity is 0.
  return bins.length > 0;
}

function pickQuantity(product) {
  // Match UI semantics (utils/product.ts -> getProductPhysicalQuantity):
  // prefer inventory.physicalQuantity when present.
  const physical = safeNumber(product?.inventory?.physicalQuantity);
  if (physical != null) return Math.max(0, physical);
  const inv = safeNumber(product?.inventory?.quantity);
  if (inv != null) return Math.max(0, inv);
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  const sum = bins.reduce((s, b) => s + (Number(b?.quantity) || 0), 0);
  return Math.max(0, sum);
}

function pickPrice(product) {
  // Prefer lowest_price.amount (EUR) which we stabilized earlier
  const candidates = [
    product?.details?.pricing?.lowest_price?.amount,
    product?.details?.pricing?.price,
    product?.details?.pricing?.msrp,
  ];
  for (const v of candidates) {
    const n = safeNumber(v);
    if (n != null) return n;
  }
  return null;
}

function pickSku(product) {
  return (
    safeString(product?.identification?.sku) ||
    safeString(product?.details?.identifiers?.sku) ||
    safeString(product?.id)
  );
}

function pickEan(product) {
  return (
    safeString(product?.details?.identifiers?.ean) ||
    safeString(product?.details?.attributes?.ean) ||
    safeString(product?.details?.attributes?.EAN) ||
    ''
  );
}

function pickMpn(product) {
  return (
    safeString(product?.details?.identifiers?.mpn) ||
    safeString(product?.details?.attributes?.mpn) ||
    safeString(product?.details?.attributes?.MPN) ||
    ''
  );
}

function pickTitle(product) {
  return safeString(product?.identification?.name) || safeString(product?.details?.title) || '';
}

function pickDescription(product) {
  return (
    safeString(product?.details?.short_description) ||
    safeString(product?.details?.description) ||
    safeString(product?.details?.long_description) ||
    ''
  );
}

function pickCategoryPath(product) {
  return (
    safeString(product?.details?.categories?.path) ||
    safeString(product?.details?.category_path) ||
    safeString(product?.details?.attributes?.category_path) ||
    ''
  );
}

function pickImageUrls(product) {
  const raw = product?.details?.images;
  const urls = [];
  if (Array.isArray(raw)) {
    for (const img of raw) {
      if (typeof img === 'string') {
        const u = safeString(img);
        if (u) urls.push(u);
      } else if (img && typeof img === 'object') {
        const u = safeString(img.url || img.src || img.href);
        if (u) urls.push(u);
      }
    }
  }
  return urls;
}

function safeJson(value) {
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

async function resolveBaseLinkerProductId(product) {
  // 1) Best: already linked on the product
  const linkedRaw = product?.ops?.baselinker?.product_id ?? product?.ops?.base_product_id ?? null;
  const linked = Number(linkedRaw);
  if (Number.isFinite(linked) && linked > 0) return { pid: linked, source: 'product.ops' };

  // 2) Next best: Firestore sku index (built from previous successful sync)
  const sku = pickSku(product);
  const ean = pickEan(product);
  const normalizedSku = normalizeSkuValue(sku);
  const normalizedEan = normalizeEanValue(ean);
  const keys = [
    buildSkuIndexKey('sku', normalizedSku),
    buildSkuIndexKey('ean', normalizedEan),
  ].filter(Boolean);

  for (const key of keys) {
    const entry = await getSkuIndexEntry(key);
    const pid = Number(entry?.baseProductId);
    if (Number.isFinite(pid) && pid > 0) return { pid, source: `sku_index:${key}` };
  }
  return { pid: null, source: null };
}

async function main() {
  const args = parseArgs(process.argv);

  const minQty = args['min-qty'] != null ? Number(args['min-qty']) : 1;
  const requireBin = args['require-bin'] != null ? String(args['require-bin']) !== '0' : true;
  const limit = args['limit'] != null ? Number(args['limit']) : null;
  const inventoryId = safeString(args['inventory-id'] || process.env.BASELINKER_INVENTORY_ID || '78659');

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(DEFAULT_OUT_DIR, ts);
  fs.mkdirSync(outDir, { recursive: true });

  const productsRaw = await getAllProducts();
  const productsNotGhost = (Array.isArray(productsRaw) ? productsRaw : []).filter((p) => !isGhostProduct(p));
  const products = await enrichProductsWithBinSummaries(productsNotGhost);

  const filtered = (Array.isArray(products) ? products : [])
    .filter((p) => p && p.id)
    .filter((p) => {
      const qty = pickQuantity(p);
      if (!(Number.isFinite(qty) && qty >= minQty)) return false;
      if (requireBin && !hasBin(p)) return false;
      return true;
    });

  const rows = [];
  for (const p of filtered) {
    const { pid, source } = await resolveBaseLinkerProductId(p);
    const images = pickImageUrls(p);
    const attrs = p?.details?.attributes || {};
    const ids = p?.details?.identifiers || {};
    const gpsr = p?.details?.gpsr || p?.details?.compliance?.gpsr || null;
    const pricing = p?.details?.pricing || {};
    const storage = p?.storage || {};
    const completeness = p?.completeness || {};
    rows.push({
      baselinker_product_id: pid || '',
      baselinker_product_id_source: source || '',
      inventory_id: inventoryId,
      avycloud_product_id: safeString(p.id),
      sku: pickSku(p),
      ean: pickEan(p),
      mpn: pickMpn(p),
      brand: safeString(p?.identification?.brand) || safeString(attrs?.Marke) || safeString(attrs?.brand) || '',
      title: pickTitle(p),
      description: pickDescription(p),
      quantity: pickQuantity(p),
      price: pickPrice(p) ?? '',
      category_path: pickCategoryPath(p),
      // Extra fields (BaseLinker import mapping can ignore or you can map to custom fields/notes):
      images: images.join(' | '),
      image_count: images.length,
      weight: safeNumber(attrs?.weight) ?? safeNumber(attrs?.Weight) ?? '',
      length: safeNumber(attrs?.length) ?? safeNumber(attrs?.Length) ?? '',
      width: safeNumber(attrs?.width) ?? safeNumber(attrs?.Width) ?? '',
      height: safeNumber(attrs?.height) ?? safeNumber(attrs?.Height) ?? '',
      bin_code: safeString(storage?.binCode) || '',
      storage_bins_json: safeJson(Array.isArray(p?.storageBins) ? p.storageBins : []),
      identifiers_json: safeJson(ids),
      attributes_json: safeJson(attrs),
      gpsr_json: safeJson(gpsr),
      pricing_json: safeJson(pricing),
      completeness_percent: completeness?.percent ?? '',
      completeness_complete: completeness?.complete === true ? '1' : '0',
      // Full payload for debugging/re-import into AvyCloud (BaseLinker can ignore this column).
      product_json: safeJson(p),
    });
    if (limit && rows.length >= limit) break;
  }

  const header = [
    'baselinker_product_id',
    'inventory_id',
    'avycloud_product_id',
    'sku',
    'ean',
    'mpn',
    'brand',
    'title',
    'description',
    'quantity',
    'price',
    'category_path',
    'images',
    'image_count',
    'weight',
    'length',
    'width',
    'height',
    'bin_code',
    'storage_bins_json',
    'identifiers_json',
    'attributes_json',
    'gpsr_json',
    'pricing_json',
    'completeness_percent',
    'completeness_complete',
    'product_json',
    // debug helper (not needed for import but useful)
    'baselinker_product_id_source',
  ];

  const MAX_BYTES = 1_800_000; // safe margin vs 2MB import limit
  let part = 1;
  let currentPath = path.join(outDir, `products-part${String(part).padStart(2, '0')}.csv`);
  let currentBytes = 0;
  let currentFd = fs.openSync(currentPath, 'w');

  const write = (str) => {
    fs.writeSync(currentFd, str);
    currentBytes += Buffer.byteLength(str, 'utf8');
  };

  // header
  const headerLine = toCsvLine(header);
  write(headerLine);

  let withPid = 0;
  let missingPid = 0;

  for (const row of rows) {
    if (row.baselinker_product_id) withPid += 1;
    else missingPid += 1;

    const line = toCsvLine(header.map((k) => row[k]));
    if (currentBytes + Buffer.byteLength(line, 'utf8') > MAX_BYTES) {
      fs.closeSync(currentFd);
      part += 1;
      currentPath = path.join(outDir, `products-part${String(part).padStart(2, '0')}.csv`);
      currentBytes = 0;
      currentFd = fs.openSync(currentPath, 'w');
      write(headerLine);
    }
    write(line);
  }

  fs.closeSync(currentFd);

  const summary = {
    outDir,
    inventoryId,
    filters: { minQty, requireBin, limit: limit || null },
    totalProducts: products.length,
    exported: rows.length,
    withBaselinkerProductId: withPid,
    missingBaselinkerProductId: missingPid,
    parts: part,
  };

  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

