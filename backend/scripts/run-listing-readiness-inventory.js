/* eslint-disable no-console */
/**
 * Run "listing_readiness" fixes for ALL inventory items (warehouse: qty>0 + BIN present),
 * then apply changes to inventory items.
 *
 * This runs against the same Firestore the backend uses (ADC required).
 *
 * Usage:
 *   node backend/scripts/run-listing-readiness-inventory.js --apply
 *
 * Notes:
 * - We intentionally select inventory items using BIN summaries (same semantics as /api/products enrichment):
 *   physicalQuantity > 0 AND has at least one BIN.
 * - Bulk action itself is idempotent; re-running is safe.
 */
const { getAllProducts } = require('../lib/firestore');
const { getProductBinSummaryMap } = require('../lib/warehouse');
const { runBulkAction } = require('../services/admin-bulk-actions');

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function normalizeIdentityKey(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized.toLowerCase();
}

function isGhostProduct(product = {}) {
  const identification = product?.identification || {};
  const details = product?.details || {};
  const sku = safeString(details?.identifiers?.sku) || safeString(identification?.sku) || '';
  const name = safeString(identification?.name) || safeString(details?.title) || '';
  if (!safeString(product?.id) && !sku) return true;
  if (!sku && !name) return true;
  const hasAnyDetailsKey = details && typeof details === 'object' && Object.keys(details).length > 0;
  const hasAnyIdentificationKey =
    identification && typeof identification === 'object' && Object.keys(identification).length > 0;
  if (!hasAnyDetailsKey && !hasAnyIdentificationKey) return true;
  return false;
}

function buildSkuToProductIdMap(products = []) {
  const map = new Map();
  products.forEach((product) => {
    if (!product || !product.id) return;
    const productId = String(product.id);
    const addKey = (value) => {
      const key = normalizeIdentityKey(value);
      if (key) {
        map.set(key, productId);
        const trimmed = key.replace(/^sku[-_\\s]*/i, '');
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
}

async function enrichProductsWithBinSummaries(products = []) {
  if (!Array.isArray(products) || products.length === 0) return products;
  const productIds = products.map((p) => (p?.id ? String(p.id) : null)).filter(Boolean);
  if (!productIds.length) return products;
  const skuMap = buildSkuToProductIdMap(products);
  const summaryMap = await getProductBinSummaryMap(productIds, skuMap);
  return products.map((product) => {
    const key = product?.id ? String(product.id) : null;
    if (!key || !summaryMap.has(key)) return product;
    const summary = summaryMap.get(key);
    const mergedInventory = {
      ...(product.inventory || {}),
      quantity: summary.totalQuantity,
      physicalQuantity: summary.totalQuantity,
    };
    return { ...product, inventory: mergedInventory, storageBins: summary.bins };
  });
}

function hasBin(product) {
  return Boolean(product?.storage?.binCode) || (Array.isArray(product?.storageBins) && product.storageBins.length > 0);
}

function getPhysicalQuantity(product) {
  const physical = product?.inventory?.physicalQuantity;
  if (typeof physical === 'number' && Number.isFinite(physical)) return Math.max(0, physical);
  const inv = product?.inventory?.quantity;
  if (typeof inv === 'number' && Number.isFinite(inv)) return Math.max(0, inv);
  const bins = Array.isArray(product?.storageBins) ? product.storageBins : [];
  return bins.reduce((s, b) => s + (Number(b?.quantity) || 0), 0);
}

async function main() {
  const apply = process.argv.includes('--apply');
  if (!apply) {
    console.log('Refusing to run without --apply (this updates Firestore).');
    process.exitCode = 2;
    return;
  }

  const all = await getAllProducts();
  const productsRaw = Array.isArray(all) ? all.filter((p) => p?.id && !isGhostProduct(p)) : [];
  const products = await enrichProductsWithBinSummaries(productsRaw);
  const inventory = products.filter((p) => hasBin(p) && getPhysicalQuantity(p) > 0);
  const productIds = inventory.map((p) => String(p.id));

  console.log(`[listing-readiness] inventory products: ${productIds.length}`);
  if (!productIds.length) return;

  const res = await runBulkAction('listing_readiness', {
    apply: true,
    productIds,
    inventoryId: '78659',
    limit: 20000,
    offset: 0,
    debug: false,
  });
  console.log('[listing-readiness] done:', JSON.stringify(res?.summary || res, null, 2));
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exitCode = 1;
});

