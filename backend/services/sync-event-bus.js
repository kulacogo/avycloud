'use strict';

/**
 * sync-event-bus.js — Event-Driven Sync Dispatcher.
 *
 * Central hub that reacts to ANY data change (orders, returns, shipments, stock)
 * and triggers the appropriate sync operations in real-time.
 *
 * Events:
 *   order:created         — New order imported from marketplace
 *   order:status_changed  — Order status changed (pack, ship, cancel, etc.)
 *   order:updated         — Order data updated (tracking, customer, etc.)
 *   return:created        — New return from marketplace or manual
 *   return:status_changed — Return status changed (processed, refunded, etc.)
 *   shipment:created      — New shipment/label created
 *   shipment:updated      — Shipment status changed (via SendCloud webhook)
 *   stock:changed         — Stock quantity changed (warehouse, restock, etc.)
 *
 * Architecture:
 *   - In-process EventEmitter (no external message broker needed)
 *   - Async handlers with error isolation (one failure doesn't block others)
 *   - Debounce per entity to prevent duplicate syncs within 5s
 *   - All handlers are fire-and-forget with structured logging
 */

const EventEmitter = require('events');
const { collectError } = require('../lib/error-collector');

const bus = new EventEmitter();
bus.setMaxListeners(50); // We'll have many handlers

// Debounce map: `${event}:${entityId}` → timestamp
const _lastEmitMs = new Map();
const _pendingEmitTimers = new Map(); // `${event}:${entityId}` -> Timeout
const DEBOUNCE_MS = 5000; // 5s debounce per entity per event type

/**
 * Emit a sync event with debounce protection.
 *
 * @param {string} event - Event name (e.g. 'order:status_changed')
 * @param {object} payload - Event data
 * @param {string} payload.entityId - ID of the entity (orderId, returnId, etc.)
 * @param {string} [payload.source] - Who triggered this (e.g. 'api', 'kaufland-webhook')
 */
function emitSyncEvent(event, payload = {}) {
  const entityId = payload.entityId || 'unknown';
  const key = `${event}:${entityId}`;
  const now = Date.now();
  const last = _lastEmitMs.get(key) || 0;

  if (now - last < DEBOUNCE_MS) {
    // Coalesce bursts: ensure one trailing emit runs after debounce window.
    const remainingMs = Math.max(25, DEBOUNCE_MS - (now - last));
    const existingTimer = _pendingEmitTimers.get(key);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      _pendingEmitTimers.delete(key);
      emitSyncEvent(event, payload);
    }, remainingMs);
    _pendingEmitTimers.set(key, timer);
    return;
  }
  const pendingTimer = _pendingEmitTimers.get(key);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    _pendingEmitTimers.delete(key);
  }
  _lastEmitMs.set(key, now);

  // Cleanup old entries periodically (every 1000 entries)
  if (_lastEmitMs.size > 1000) {
    const cutoff = now - 60_000;
    for (const [k, ts] of _lastEmitMs) {
      if (ts < cutoff) _lastEmitMs.delete(k);
    }
  }

  console.log(`[sync-bus] ${event} entity=${entityId} source=${payload.source || '?'}`);
  bus.emit(event, payload);
}

// ─── Handler Registration ────────────────────────────────────

/**
 * When an order status changes → sync stock to all channels + sync to marketplaces.
 */
bus.on('order:status_changed', async (payload) => {
  const { entityId: orderId, tenantId = 'default', toStatus, fromStatus, source } = payload;
  try {
    // 1. Sync stock to all channels (covers eBay, Kaufland)
    // NOTE: syncStockForOrderItems reads current stock and pushes to marketplaces — it does NOT decrement.
    // Decrement is handled by processShippedOrder() (idempotent). This sync is a safety-net.
    const { syncStockForOrderItems } = require('./stock-sync-dispatcher');
    await syncStockForOrderItems({ tenantId, orderId, reason: `status:${toStatus}` })
      .catch((err) => console.warn(`[sync-bus] stock sync failed for order ${orderId}: ${err.message}`));

    // 2. If cancelled → release reservations + push cancellation to marketplace
    if (toStatus === 'cancelled') {
      try {
        const { releaseReservation } = require('./stock-reservation');
        await releaseReservation({ tenantId, orderId });
      } catch (err) {
        console.warn(`[sync-bus] release reservation failed for ${orderId}: ${err.message}`);
      }
      try {
        const { pushCancellationToMarketplace } = require('./marketplace-tracking');
        const result = await pushCancellationToMarketplace({ orderId });
        console.log(`[sync-bus] marketplace cancel push for ${orderId}: ok=${result.ok}`);
      } catch (err) {
        console.warn(`[sync-bus] marketplace cancel push failed for ${orderId}: ${err.message}`);
      }
    }

    // 3. If shipped → ensure marketplace tracking push succeeded (backup for fire-and-forget in route)
    if (toStatus === 'shipped') {
      try {
        const { ensureMarketplaceTrackingPushed } = require('./marketplace-tracking');
        await ensureMarketplaceTrackingPushed({ orderId });
      } catch (err) {
        console.warn(`[sync-bus] marketplace tracking push check failed for ${orderId}: ${err.message}`);
      }
    }

    // 4. Trigger marketplace order sync (picks up all status changes from both sides)
    _debouncedMarketplaceOrderSync(tenantId);

  } catch (err) {
    console.error(`[sync-bus] order:status_changed handler error: ${err.message}`);
    collectError({ tenantId, type: 'sync_failure', severity: 'warning', channel: 'internal', message: `Sync-Bus order:status_changed failed: ${err.message}`, entityType: 'order', entityId: orderId, source: 'sync-event-bus' });
  }
});

/**
 * When a new order is created → sync stock + trigger full order sync.
 */
bus.on('order:created', async (payload) => {
  const { entityId: orderId, tenantId = 'default', source } = payload;
  try {
    // Safety-net: push current availability to marketplaces for order SKUs
    const { syncStockForOrderItems } = require('./stock-sync-dispatcher');
    await syncStockForOrderItems({ tenantId, orderId, reason: 'order-created' })
      .catch((err) => console.warn(`[sync-bus] stock sync failed for new order ${orderId}: ${err.message}`));

    // Trigger marketplace sync to pick up any other new orders
    _debouncedMarketplaceOrderSync(tenantId);

  } catch (err) {
    console.error(`[sync-bus] order:created handler error: ${err.message}`);
  }
});

/**
 * When order data is updated (tracking etc.) → sync to marketplaces.
 */
bus.on('order:updated', async (payload) => {
  const { entityId: orderId, tenantId = 'default' } = payload;
  try {
    _debouncedMarketplaceOrderSync(tenantId);
  } catch (err) {
    console.error(`[sync-bus] order:updated handler error: ${err.message}`);
  }
});

/**
 * When a return is created or status changes → sync returns from marketplaces
 * + sync stock if restocked.
 */
bus.on('return:created', async (payload) => {
  const { tenantId = 'default' } = payload;
  try {
    _debouncedReturnSync(tenantId);
  } catch (err) {
    console.error(`[sync-bus] return:created handler error: ${err.message}`);
  }
});

bus.on('return:status_changed', async (payload) => {
  const { entityId: returnId, tenantId = 'default', toStatus } = payload;
  try {
    // If restocked → sync stock to all channels
    if (['erstattet', 'teilweise_erstattet'].includes(toStatus)) {
      const { firestore } = require('../lib/firestore');
      const snap = await firestore.collection('returns').doc(returnId).get();
      if (snap.exists) {
        const ret = snap.data();
        if (ret.restock && ret.orderId) {
          const { syncStockForOrderItems } = require('./stock-sync-dispatcher');
          await syncStockForOrderItems({ tenantId, orderId: ret.orderId, reason: 'return-restock' })
            .catch((err) => console.warn(`[sync-bus] restock stock sync failed: ${err.message}`));
        }
      }
    }
    _debouncedReturnSync(tenantId);
  } catch (err) {
    console.error(`[sync-bus] return:status_changed handler error: ${err.message}`);
  }
});

/**
 * When a shipment is created or updated → sync SendCloud parcels + stock.
 */
bus.on('shipment:created', async (payload) => {
  const { entityId: orderId, tenantId = 'default' } = payload;
  try {
    _debouncedSendCloudSync(tenantId);
  } catch (err) {
    console.error(`[sync-bus] shipment:created handler error: ${err.message}`);
  }
});

bus.on('shipment:updated', async (payload) => {
  const { entityId: orderId, tenantId = 'default', statusId } = payload;
  try {
    // If returned → trigger return sync + stock sync
    if ([15, 32, 33].includes(statusId)) {
      _debouncedReturnSync(tenantId);
    }
    _debouncedSendCloudSync(tenantId);
  } catch (err) {
    console.error(`[sync-bus] shipment:updated handler error: ${err.message}`);
  }
});

/**
 * When stock changes → sync to all marketplace channels.
 */
bus.on('stock:changed', async (payload) => {
  const { entityId: productId, tenantId = 'default', reason } = payload;
  try {
    if (!productId) return;

    // Load product from products_v2 (active collection)
    const { getProductV2 } = require('../lib/product-store');
    const product = await getProductV2(productId);
    if (!product) return;

    const { syncStockWithRetry } = require('./stock-sync-dispatcher');
    await syncStockWithRetry({ tenantId, product, reason: `event:${reason || 'stock-changed'}` })
      .catch((err) => console.warn(`[sync-bus] stock channel sync failed for ${productId}: ${err.message}`));

  } catch (err) {
    console.error(`[sync-bus] stock:changed handler error: ${err.message}`);
  }
});

// ─── Debounced Aggregate Syncs (per-tenant) ──────────────────
// HARDEN-Wave-2 (2026-05-22): Debounce-Timer waren VORHER GLOBAL — wenn
// Tenant A und Tenant B im selben 3s-Fenster ein Event auslösten, gewann
// der erste und der zweite Tenant wurde übersprungen ("Cross-Tenant-
// Starvation"). Jetzt: Map<tenantId, Timer> pro Sync-Typ — jeder Tenant
// bekommt sein eigenes Debounce-Fenster.

const _marketplaceSyncTimers = new Map(); // tenantId -> Timeout
function _debouncedMarketplaceOrderSync(tenantId) {
  const tenant = String(tenantId || 'default').trim() || 'default';
  if (_marketplaceSyncTimers.has(tenant)) return; // Already scheduled for this tenant
  const timer = setTimeout(async () => {
    _marketplaceSyncTimers.delete(tenant);
    try {
      const { syncEbayOrders } = require('./order-intake-ebay');
      const { syncKauflandOrders } = require('./order-intake-kaufland');
      const [ebay, kaufland] = await Promise.allSettled([
        syncEbayOrders({ tenantId: tenant, lookbackDays: 3 }),
        syncKauflandOrders({ tenantId: tenant, lookbackDays: 3 }),
      ]);
      console.log(`[sync-bus] marketplace order sync (tenant=${tenant}): ebay=${ebay.status} kaufland=${kaufland.status}`);
    } catch (err) {
      console.warn(`[sync-bus] marketplace order sync failed (tenant=${tenant}): ${err.message}`);
    }
  }, 3000);
  _marketplaceSyncTimers.set(tenant, timer);
}

const _returnSyncTimers = new Map();
function _debouncedReturnSync(tenantId) {
  const tenant = String(tenantId || 'default').trim() || 'default';
  if (_returnSyncTimers.has(tenant)) return;
  const timer = setTimeout(async () => {
    _returnSyncTimers.delete(tenant);
    try {
      const { syncAllReturns } = require('./returns-engine');
      const result = await syncAllReturns({ tenantId: tenant, lookbackDays: 14 });
      console.log(`[sync-bus] return sync (tenant=${tenant}): ebay=${JSON.stringify(result.ebay)} kaufland=${JSON.stringify(result.kaufland)}`);
    } catch (err) {
      console.warn(`[sync-bus] return sync failed (tenant=${tenant}): ${err.message}`);
    }
  }, 3000);
  _returnSyncTimers.set(tenant, timer);
}

const _sendCloudSyncTimers = new Map();
function _debouncedSendCloudSync(tenantId) {
  const tenant = String(tenantId || 'default').trim() || 'default';
  if (_sendCloudSyncTimers.has(tenant)) return;
  const timer = setTimeout(async () => {
    _sendCloudSyncTimers.delete(tenant);
    try {
      const { syncSendCloudParcels } = require('./shipping-engine');
      const fromDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
      const result = await syncSendCloudParcels({ tenantId: tenant, fromDate });
      console.log(`[sync-bus] sendcloud sync (tenant=${tenant}): matched=${result.matched?.length || 0}`);
    } catch (err) {
      console.warn(`[sync-bus] sendcloud sync failed (tenant=${tenant}): ${err.message}`);
    }
  }, 3000);
  _sendCloudSyncTimers.set(tenant, timer);
}

module.exports = {
  emitSyncEvent,
  bus, // Expose for testing
};
