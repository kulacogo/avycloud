'use strict';

// A unit is sellable only while allocated to a named warehouse BIN. No
// relocation or legacy primary-location exception. The ledger remains a cap.
function locatedQuantity(product) {
  if (!Array.isArray(product?.storageBins)) return 0;
  const bins = new Map();
  for (const bin of product.storageBins) {
    const code = String(bin?.code || bin?.binCode || '').trim();
    const n = Number(bin?.quantity);
    if (!code || !Number.isFinite(n) || n <= 0) continue;
    // Duplicate projections must never multiply the same physical units.
    bins.set(code, Math.min(bins.get(code) ?? Infinity, Math.floor(n)));
  }
  return [...bins.values()].reduce((sum, n) => sum + n, 0);
}

// Canonical projection and located units cap marketplace quantities.
// Unknown/invalid quantities fail closed. Overrides may only reduce stock.
function resolveMarketplaceQuantity(product, requested) {
  const physical = Number(product?.inventory?.quantity);
  if (!Number.isFinite(physical) || physical <= 0) return 0;
  let quantity = Math.min(Math.floor(physical), locatedQuantity(product));
  for (const candidate of [product?.inventory?.availableQuantity, requested]) {
    if (candidate === undefined || candidate === null) continue;
    const n = Number(candidate);
    if (!Number.isFinite(n) || n < 0) return 0;
    quantity = Math.min(quantity, Math.floor(n));
  }
  return quantity;
}
module.exports = { resolveMarketplaceQuantity, locatedQuantity };

// Recheck immediately before a publish, including every auto-fix retry. Never
// treat an unavailable database/reservation read as permission to sell.
async function readMarketplaceQuantity(product, requested, deps = {}) {
  const firestore = deps.firestore || require('./firestore').firestore;
  const getReservedQuantity = deps.getReservedQuantity || require('../services/stock-reservation').getReservedQuantity;
  if (!product?.id) throw new Error('Stock verification requires product id');
  const snap = await firestore.collection('products_v2').doc(product.id).get();
  if (!snap.exists) throw new Error('Stock verification: product no longer exists');
  const fresh = { ...snap.data(), id: snap.id };
  const tenantId = product.tenantId || 'default';
  if ((fresh.tenantId || 'default') !== tenantId) throw new Error('Stock verification: tenant mismatch');
  const sku = fresh.identification?.sku || fresh.details?.identifiers?.sku;
  const reservations = await Promise.all([
    getReservedQuantity({ tenantId, productId: product.id }),
    ...(sku ? [getReservedQuantity({ tenantId, sku })] : []),
  ]);
  if (reservations.some(n => !Number.isFinite(Number(n)) || Number(n) < 0)) throw new Error('Invalid reserved stock');
  const verifiedLocated = await readLocatedQuantity(fresh, firestore);
  const availableQuantity = Math.max(0, Math.min(verifiedLocated, resolveMarketplaceQuantity({ ...fresh, inventory: { quantity: fresh.inventory?.quantity } })) - Math.max(...reservations));
  return resolveMarketplaceQuantity({ ...fresh, inventory: { ...fresh.inventory, availableQuantity } }, requested);
}
module.exports.readMarketplaceQuantity = readMarketplaceQuantity;

// Product locations are a projection. Verify actual BIN membership before any
// marketplace stock increase, sync or automatic relist. Read errors propagate.
async function readLocatedQuantity(product, firestore) {
  if (!Array.isArray(product?.storageBins)) return 0;
  const { buildProductKeySet, binEntryMatchesKeySet } = require('./warehouse-product-keys');
  const keys = buildProductKeySet(product);
  const tenantId = product.tenantId || 'default';
  const allocations = new Map();
  for (const bin of product.storageBins) {
    const code = String(bin?.code || bin?.binCode || '').trim();
    const qty = Number(bin?.quantity);
    if (!code || !Number.isFinite(qty) || qty <= 0) continue;
    allocations.set(code, Math.min(allocations.get(code) ?? Infinity, Math.floor(qty)));
  }
  const quantities = await Promise.all([...allocations].map(async ([code, cap]) => {
    const snap = await firestore.collection('warehouseBins').doc(code).get();
    if (!snap.exists) return 0;
    const bin = snap.data();
    // Legacy warehouse BINs without tenantId belong only to the default tenant.
    if ((bin?.tenantId || 'default') !== tenantId) throw new Error('BIN tenant mismatch');
    const actual = (Array.isArray(bin.products) ? bin.products : [])
      .filter(entry => binEntryMatchesKeySet(entry, keys))
      .reduce((sum, entry) => {
        const n = Number(entry.quantity);
        if (!Number.isFinite(n) || n < 0) throw new Error('Invalid BIN quantity');
        return sum + Math.floor(n);
      }, 0);
    return Math.min(cap, actual);
  }));
  return quantities.reduce((sum, qty) => sum + qty, 0);
}
module.exports.readLocatedQuantity = readLocatedQuantity;
