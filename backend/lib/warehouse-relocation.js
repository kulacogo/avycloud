'use strict';

// Relocation stock is already part of inventory/ledger. It has no BIN until
// ordinary stow assigns it again; it must never become a second stock receipt.
function hasRelocationStock(product) {
  return Boolean(product?.ops?.relocation && typeof product.ops.relocation === 'object');
}

function getUnassignedQuantity(product) {
  const raw = product?.ops?.relocation?.unassignedQuantity;
  if (raw === undefined || raw === null) return 0;
  const quantity = Number(raw);
  if (!Number.isFinite(quantity) || quantity < 0) {
    throw new Error('Ungültiger Umzugsbestand; Lagerbuchung abgebrochen.');
  }
  return quantity;
}

function planRelocationStockIn(product, quantity, meta = {}) {
  const unassigned = getUnassignedQuantity(product);
  // Returns, cancelled orders, repairs and inventory corrections are true
  // receipts. Only the normal stow API may consume existing relocation stock.
  const normalStow = meta?.source === 'api' && meta?.action === 'stock-in'
    && !meta.orderId && !meta.returnId && !meta.inventoryId && !meta.repairId
    && (!meta.flow || meta.flow === 'stow');
  const relocatedQuantity = normalStow ? Math.min(unassigned, quantity) : 0;
  return {
    relocatedQuantity,
    delta: quantity - relocatedQuantity,
    unassignedQuantity: unassigned - relocatedQuantity,
  };
}

function relocatedStockTotal(product, binTotal) {
  return binTotal + getUnassignedQuantity(product);
}

module.exports = { hasRelocationStock, getUnassignedQuantity, planRelocationStockIn, relocatedStockTotal };
