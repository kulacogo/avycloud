/**
 * Stock-Change-Event & Inventory-Ledger.
 *
 * Wird an JEDER Stelle aufgerufen, die `products_v2.inventory.quantity` mutiert:
 *   - lib/product-store.js saveProductV2()
 *   - lib/warehouse.js refreshProductInventory()
 *
 * Zwei Aufgaben:
 *   1) Emittiert `stock:changed` auf dem sync-event-bus → triggert Marketplace-Sync-Listener
 *      (feature-flag STOCK_CHANGED_EMIT_ENABLED)
 *   2) Schreibt append-only Eintrag in `inventory_ledger` Collection
 *      (feature-flag INVENTORY_LEDGER_ENABLED)
 *
 * Beides ist fehlertolerant: wenn event-bus oder Firestore versagen,
 * wird geloggt aber kein Error gethrown — damit die urspruengliche Stock-Mutation
 * nicht retrospektiv fehlschlaegt.
 *
 * Siehe CLAUDE.md Punkt 10 (Oversell-Verbot) und Plan P2.3 + P2.4.
 */

'use strict';

function emitEnabled() {
  return process.env.STOCK_CHANGED_EMIT_ENABLED !== 'false';
}

function ledgerEnabled() {
  return process.env.INVENTORY_LEDGER_ENABLED !== 'false';
}

async function notifyStockChange({
  tenantId = 'default',
  productId,
  sku,
  before,
  after,
  reason = 'unknown',
  source = 'unknown',
  actor = null,
} = {}) {
  if (!productId) return;
  if (before === null || before === undefined || after === null || after === undefined) return;
  const bNum = Number(before);
  const aNum = Number(after);
  if (!Number.isFinite(bNum) || !Number.isFinite(aNum)) return;
  if (bNum === aNum) return;

  // 1) emit stock:changed event
  if (emitEnabled()) {
    try {
      const bus = require('../services/sync-event-bus');
      if (bus && typeof bus.emitSyncEvent === 'function') {
        bus.emitSyncEvent('stock:changed', {
          tenantId,
          entityId: productId,
          productId,
          sku: sku || null,
          before: bNum,
          after: aNum,
          delta: aNum - bNum,
          reason,
          source,
        });
      }
    } catch (err) {
      console.warn(`[stock-change-events] emit failed productId=${productId}: ${err.message}`);
    }
  }

  // 2) append to inventory_ledger
  if (ledgerEnabled()) {
    try {
      const { firestore } = require('./firestore');
      await firestore.collection('inventory_ledger').add({
        tenantId,
        productId,
        sku: sku || null,
        before: bNum,
        after: aNum,
        delta: aNum - bNum,
        reason,
        source,
        actor: actor ? { uid: actor.uid || null, email: actor.email || null } : null,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      console.warn(`[stock-change-events] ledger write failed productId=${productId}: ${err.message}`);
    }
  }
}

module.exports = { notifyStockChange };
