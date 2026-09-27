'use strict';

// Canonical projection wins over stale locations and marketplace mirrors.
// Unknown/invalid quantities fail closed. Overrides may only reduce stock.
function resolveMarketplaceQuantity(product, requested) {
  const physical = Number(product?.inventory?.quantity);
  if (!Number.isFinite(physical) || physical <= 0) return 0;
  let quantity = Math.floor(physical);
  for (const candidate of [product?.inventory?.availableQuantity, requested]) {
    if (candidate === undefined || candidate === null) continue;
    const n = Number(candidate);
    if (!Number.isFinite(n) || n < 0) return 0;
    quantity = Math.min(quantity, Math.floor(n));
  }
  return quantity;
}
module.exports = { resolveMarketplaceQuantity };

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
  const availableQuantity = Math.max(0, Number(fresh.inventory?.quantity) - Math.max(...reservations));
  return resolveMarketplaceQuantity({ ...fresh, inventory: { ...fresh.inventory, availableQuantity } }, requested);
}
module.exports.readMarketplaceQuantity = readMarketplaceQuantity;
