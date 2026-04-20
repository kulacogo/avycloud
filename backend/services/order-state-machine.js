'use strict';

/**
 * order-state-machine.js — Status-Engine für das AvyCloud OMS.
 *
 * Definiert den Order-Status-Flow und validiert Übergänge.
 * Jeder Übergang wird als Event in der `order_events` Collection protokolliert.
 *
 * Flow: pending → confirmed → picking → picked → packing → packed → shipped → delivered → completed
 * Sonderstatus: cancelled, returned, on_hold
 */

const { Firestore, FieldValue } = require('@google-cloud/firestore');

const ORDER_EVENTS_COLLECTION = 'order_events';
const ORDERS_COLLECTION = 'orders';

let _db;
function getDb() {
  if (!_db) _db = new Firestore();
  return _db;
}

// ─── Status Definitions ──────────────────────────────────────

const ORDER_STATUSES = {
  pending:    { label: 'Neu',           color: 'blue',   sortOrder: 0 },
  confirmed:  { label: 'Bestätigt',     color: 'blue',   sortOrder: 1 },
  picking:    { label: 'Kommissionierung', color: 'orange', sortOrder: 2 },
  picked:     { label: 'Kommissioniert', color: 'purple', sortOrder: 3 },
  packing:    { label: 'Verpackung',    color: 'orange', sortOrder: 4 },
  packed:     { label: 'Verpackt',      color: 'green',  sortOrder: 5 },
  shipped:    { label: 'Versendet',     color: 'green',  sortOrder: 6 },
  delivered:  { label: 'Zugestellt',    color: 'green',  sortOrder: 7 },
  completed:  { label: 'Abgeschlossen', color: 'gray',   sortOrder: 8 },
  cancelled:  { label: 'Storniert',     color: 'red',    sortOrder: 9 },
  returned:   { label: 'Retourniert',   color: 'red',    sortOrder: 10 },
  on_hold:    { label: 'Zurückgestellt', color: 'yellow', sortOrder: 11 },
};

// ─── Allowed Transitions ─────────────────────────────────────

const TRANSITIONS = {
  pending:    ['confirmed', 'picking', 'cancelled', 'on_hold'],
  confirmed:  ['picking', 'cancelled', 'on_hold'],
  picking:    ['picked', 'cancelled', 'on_hold'],
  picked:     ['packing', 'packed', 'cancelled', 'on_hold'],
  packing:    ['packed', 'cancelled', 'on_hold'],
  packed:     ['shipped', 'cancelled', 'on_hold'],
  shipped:    ['delivered', 'returned'],
  delivered:  ['completed', 'returned'],
  completed:  ['returned'],
  cancelled:  ['pending'],  // Re-open cancelled order
  returned:   [],           // Terminal
  on_hold:    ['pending', 'confirmed', 'picking', 'cancelled'],
};

/**
 * Check if a status transition is allowed.
 * @param {string} fromStatus
 * @param {string} toStatus
 * @returns {boolean}
 */
function isTransitionAllowed(fromStatus, toStatus) {
  const allowed = TRANSITIONS[fromStatus];
  if (!allowed) return false;
  return allowed.includes(toStatus);
}

/**
 * Get all statuses a given status can transition to.
 * @param {string} fromStatus
 * @returns {string[]}
 */
function getNextStatuses(fromStatus) {
  return TRANSITIONS[fromStatus] || [];
}

/**
 * Get status metadata.
 * @param {string} status
 * @returns {{ label: string, color: string, sortOrder: number } | null}
 */
function getStatusInfo(status) {
  return ORDER_STATUSES[status] || null;
}

/**
 * Get all status definitions.
 * @returns {object}
 */
function getAllStatuses() {
  return { ...ORDER_STATUSES };
}

// ─── Status Transition with Event Logging ────────────────────

/**
 * Transition an order to a new status.
 * Validates the transition, updates Firestore, and logs an event.
 *
 * @param {{ tenantId?: string, orderId: string, toStatus: string, actor: { uid: string, email: string }, note?: string }} opts
 * @returns {Promise<{ ok: boolean, fromStatus: string, toStatus: string, error?: string }>}
 */
async function transitionOrder({ tenantId = 'default', orderId, toStatus, actor, note, force = false, timestamps = {} }) {
  if (!orderId) return { ok: false, error: 'orderId ist erforderlich' };
  if (!toStatus) return { ok: false, error: 'toStatus ist erforderlich' };
  if (!ORDER_STATUSES[toStatus]) return { ok: false, error: `Unbekannter Status: ${toStatus}` };

  const db = getDb();
  const orderRef = db.collection(ORDERS_COLLECTION).doc(orderId);

  // Use transaction for atomic read-check-update
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) {
      return { ok: false, error: 'Auftrag nicht gefunden' };
    }

    const order = snap.data();
    const fromStatus = order.omsStatus || order.status || 'pending';

    if (fromStatus === toStatus) {
      return { ok: false, fromStatus, toStatus, error: 'Auftrag ist bereits in diesem Status' };
    }

    // Skip transition validation when force=true (manual override)
    if (!force && !isTransitionAllowed(fromStatus, toStatus)) {
      const allowed = getNextStatuses(fromStatus).map((s) => ORDER_STATUSES[s]?.label || s).join(', ');
      return {
        ok: false,
        fromStatus,
        toStatus,
        error: `Übergang von "${ORDER_STATUSES[fromStatus]?.label || fromStatus}" zu "${ORDER_STATUSES[toStatus]?.label || toStatus}" ist nicht erlaubt. Erlaubt: ${allowed}`,
      };
    }

    // Build update payload
    const update = {
      omsStatus: toStatus,
      omsStatusLabel: ORDER_STATUSES[toStatus].label,
      updatedAt: new Date().toISOString(),
    };

    // Set timestamp fields — caller can pass explicit timestamps, otherwise auto-set
    const now = new Date().toISOString();
    const tsMap = {
      picking: 'pickedAt', picked: 'pickedAt',
      packed: 'packedAt', shipped: 'shippedAt',
      delivered: 'deliveredAt', completed: 'completedAt',
      cancelled: 'cancelledAt',
    };
    const tsField = tsMap[toStatus];
    if (tsField) {
      // Use caller-provided timestamp, or auto-set if not explicitly suppressed
      if (timestamps[tsField] !== undefined) {
        if (timestamps[tsField]) update[tsField] = timestamps[tsField];
        // if null, skip setting (caller explicitly suppressed)
      } else {
        update[tsField] = now;
      }
    }

    // Update order
    tx.set(orderRef, update, { merge: true });

    // Log event
    const eventRef = db.collection(ORDER_EVENTS_COLLECTION).doc();
    tx.set(eventRef, {
      orderId,
      tenantId,
      event: 'status_change',
      fromStatus,
      toStatus,
      fromStatusLabel: ORDER_STATUSES[fromStatus]?.label || fromStatus,
      toStatusLabel: ORDER_STATUSES[toStatus]?.label || toStatus,
      actor: actor ? { uid: actor.uid, email: actor.email } : null,
      note: note || null,
      timestamp: FieldValue.serverTimestamp(),
    });

    return { ok: true, fromStatus, toStatus };
  });

  // Post-transition side effects (fire-and-forget)
  if (result.ok && toStatus === 'shipped') {
    // Auto-generate invoice when order ships (FEAT-ORD-06)
    try {
      const { generateInvoice } = require('./invoice-engine');
      generateInvoice({ orderId, tenantId, actor }).catch((err) => {
        console.warn(`[order-state-machine] Auto-invoice for ${orderId} failed: ${err.message}`);
      });
    } catch (err) {
      console.warn(`[order-state-machine] Auto-invoice import failed: ${err.message}`);
    }

    // Decrement physical stock + sync to all marketplaces (oversell prevention)
    _onOrderShipped({ orderId, tenantId }).catch((err) => {
      console.warn(`[order-state-machine] Stock-out for ${orderId} failed: ${err.message}`);
    });
  }

  if (result.ok && toStatus === 'cancelled') {
    // Release soft-locked stock + re-sync marketplaces
    _onOrderCancelled({ orderId, tenantId }).catch((err) => {
      console.warn(`[order-state-machine] Stock-release for ${orderId} failed: ${err.message}`);
    });
  }

  return result;
}

/**
 * On order shipped: confirm reservation + decrement physical stock + push to marketplaces.
 */
async function _onOrderShipped({ orderId, tenantId }) {
  const db = getDb();
  const failures = [];

  // 1. Confirm reservation
  try {
    const { confirmReservation } = require('./stock-reservation');
    const res = await confirmReservation({ tenantId, orderId });
    console.log(`[order-state-machine] confirmReservation orderId=${orderId} confirmed=${res.confirmed}`);
  } catch (err) {
    console.warn(`[order-state-machine] confirmReservation failed orderId=${orderId}: ${err.message}`);
    failures.push({ step: 'confirmReservation', error: err.message });
  }

  // 2. Atomic Claim: Read order + claim stockDecrementedAt in EINER Transaction
  // Verhindert Race Condition: Zwei gleichzeitige Aufrufe koennen nicht beide Phase A betreten.
  // Ein Aufrufer "gewinnt" den Claim und fuehrt Phase A aus, der andere sieht `alreadyDecremented`.
  const orderRef = db.collection(ORDERS_COLLECTION).doc(orderId);
  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) return { skip: true, reason: 'not_found' };
    const order = snap.data();
    const items = order.items || [];
    if (items.length === 0) return { skip: true, reason: 'no_items' };

    if (order.stockDecrementedAt) {
      return { skip: false, alreadyDecremented: true, items, previousDecrementedAt: order.stockDecrementedAt };
    }

    // Claim atomically — setze Flag JETZT bevor Phase A startet.
    // Wenn Phase A fuer ALLE SKUs fehlschlaegt, wird der Claim am Ende zurueckgesetzt.
    const skus = items.map((i) => String(i.sku || '').trim()).filter(Boolean);
    tx.update(orderRef, {
      stockDecrementedAt: new Date().toISOString(),
      stockDecrementedSkus: skus,
    });
    return { skip: false, alreadyDecremented: false, items };
  });

  if (claim.skip) return;
  const { alreadyDecremented, items } = claim;
  if (alreadyDecremented) {
    console.log(`[order-state-machine] Stock already decremented for ${orderId} at ${claim.previousDecrementedAt} — skipping decrement, running marketplace sync only`);
  }

  // 3. Build SKU→qty map
  const { syncStockWithRetry } = require('./stock-sync-dispatcher');
  const { decrementProductByIdOrSku } = require('../lib/warehouse');
  const { firestore: fs } = require('../lib/firestore');
  const { withStockLock } = require('../lib/stock-lock');

  const skuQtyMap = {};
  for (const item of items) {
    const sku = String(item.sku || '').trim();
    if (!sku) continue;
    skuQtyMap[sku] = (skuQtyMap[sku] || 0) + (Number(item.quantity) || 1);
  }

  // Phase A — Decrement ALL SKUs first (nur wenn Claim gewonnen)
  if (!alreadyDecremented) {
    for (const [sku, sold] of Object.entries(skuQtyMap)) {
      await withStockLock(sku, async () => {
        try {
          await decrementProductByIdOrSku(sku, sold);
          console.log(`[order-state-machine] stock-out sku=${sku} qty=${sold} (bins + inventory decremented)`);
        } catch (err) {
          console.error(`[order-state-machine] decrementProductByIdOrSku failed sku=${sku}: ${err.message}`);
          failures.push({ step: 'decrement', sku, qty: sold, error: err.message });
        }
      });
    }

    // Rollback: Wenn ALLE Decrements fehlgeschlagen sind, Claim zuruecksetzen damit Retry moeglich ist.
    // Wenn mindestens 1 SKU erfolgreich war, bleibt der Claim bestehen (Teil-Erfolg = Flag bleibt).
    const decrementFailures = failures.filter((f) => f.step === 'decrement');
    const totalSkus = Object.keys(skuQtyMap).length;
    if (totalSkus > 0 && decrementFailures.length === totalSkus) {
      try {
        await orderRef.update({
          stockDecrementedAt: FieldValue.delete(),
          stockDecrementedSkus: FieldValue.delete(),
        });
        console.warn(`[order-state-machine] All ${totalSkus} decrements failed for ${orderId} — claim released for retry`);
      } catch (rollbackErr) {
        console.error(`[order-state-machine] Failed to release claim after total failure for ${orderId}: ${rollbackErr.message}`);
      }
    }
  }

  // Phase B — THEN sync all SKUs to marketplaces (reads post-decrement data, runs ALWAYS)
  for (const sku of Object.keys(skuQtyMap)) {
    try {
      let snap = await fs.collection('products_v2')
        .where('identification.sku', '==', sku)
        .limit(1)
        .get();
      if (snap.empty) {
        snap = await fs.collection('products_v2')
          .where('details.identifiers.sku', '==', sku)
          .limit(1)
          .get();
      }
      if (!snap.empty) {
        const doc = snap.docs[0];
        const product = { id: doc.id, ...doc.data() };
        await syncStockWithRetry({ tenantId, product, reason: `shipped-${orderId}` });
      }
    } catch (err) {
      console.warn(`[order-state-machine] marketplace sync failed sku=${sku}: ${err.message}`);
      failures.push({ step: 'marketplaceSync', sku, error: err.message });
    }
  }

  // Persist failures for recovery
  if (failures.length > 0) {
    try {
      await db.collection('stock_operation_failures').add({
        tenantId,
        orderId,
        operation: 'shipped',
        failures,
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      console.error(`[order-state-machine] ${failures.length} stock failures for ${orderId} persisted to stock_operation_failures`);
    } catch (persistErr) {
      console.error(`[order-state-machine] CRITICAL: Failed to persist stock failures for ${orderId}:`, persistErr.message);
    }
  }
}

/**
 * On order cancelled: release reservation + re-sync available stock to marketplaces.
 */
async function _onOrderCancelled({ orderId, tenantId }) {
  // Release the soft-lock
  try {
    const { releaseReservation } = require('./stock-reservation');
    const res = await releaseReservation({ tenantId, orderId });
    console.log(`[order-state-machine] releaseReservation orderId=${orderId} released=${res.released}`);
  } catch (err) {
    console.warn(`[order-state-machine] releaseReservation failed orderId=${orderId}: ${err.message}`);
  }

  // Re-sync stock to marketplaces (available qty just increased due to release)
  const db = getDb();
  const orderDoc = await db.collection(ORDERS_COLLECTION).doc(orderId).get();
  if (!orderDoc.exists) return;
  const order = orderDoc.data();
  const items = order.items || [];

  const skus = [...new Set(items.map((i) => String(i.sku || '').trim()).filter(Boolean))];
  if (skus.length === 0) return;

  const { syncStockWithRetry } = require('./stock-sync-dispatcher');
  const { firestore: fs } = require('../lib/firestore');

  for (const sku of skus) {
    try {
      let snap = await fs.collection('products_v2')
        .where('identification.sku', '==', sku)
        .limit(1)
        .get();
      if (snap.empty) {
        snap = await fs.collection('products_v2')
          .where('details.identifiers.sku', '==', sku)
          .limit(1)
          .get();
      }
      if (!snap.empty) {
        const doc = snap.docs[0];
        const product = { id: doc.id, ...doc.data() };
        syncStockWithRetry({ tenantId, product, reason: `cancelled-${orderId}` })
          .catch((err) => console.warn(`[order-state-machine] channel sync failed after cancel sku=${sku}: ${err.message}`));
      }
    } catch (err) {
      console.warn(`[order-state-machine] cancel sync lookup failed sku=${sku}: ${err.message}`);
    }
  }
}

/**
 * Get the event history (timeline) for an order.
 * @param {{ orderId: string, limit?: number }} opts
 * @returns {Promise<object[]>}
 */
async function getOrderTimeline({ orderId, limit = 50 }) {
  const snap = await getDb()
    .collection(ORDER_EVENTS_COLLECTION)
    .where('orderId', '==', orderId)
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .get();

  return snap.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      event: d.event,
      fromStatus: d.fromStatus,
      toStatus: d.toStatus,
      fromStatusLabel: d.fromStatusLabel,
      toStatusLabel: d.toStatusLabel,
      actor: d.actor,
      note: d.note,
      timestamp: d.timestamp?.toDate?.()?.toISOString() || d.timestamp || null,
    };
  });
}

/**
 * Get order counts grouped by OMS status.
 * @param {{ tenantId?: string }} opts
 * @returns {Promise<Record<string, number>>}
 */
async function getStatusCounts({ tenantId = 'default' } = {}) {
  // Firestore doesn't support GROUP BY — we query all and count client-side
  const snap = await getDb()
    .collection(ORDERS_COLLECTION)
    .where('tenantId', '==', tenantId)
    .select('omsStatus', 'status')
    .limit(5000)
    .get();

  const counts = {};
  for (const status of Object.keys(ORDER_STATUSES)) {
    counts[status] = 0;
  }

  for (const doc of snap.docs) {
    const d = doc.data();
    const status = d.omsStatus || d.status || 'pending';
    const mapped = mapLegacyStatus(status);
    counts[mapped] = (counts[mapped] || 0) + 1;
  }

  return counts;
}

/**
 * Map legacy status to OMS status.
 * @param {string} status
 * @returns {string}
 */
function mapLegacyStatus(status) {
  const legacyMap = {
    new: 'pending',
    picking: 'picking',
    picked: 'picked',
    packed: 'packed',
    other: 'pending',
  };
  return legacyMap[status] || (ORDER_STATUSES[status] ? status : 'pending');
}

module.exports = {
  ORDER_STATUSES,
  TRANSITIONS,
  isTransitionAllowed,
  getNextStatuses,
  getStatusInfo,
  getAllStatuses,
  transitionOrder,
  processShippedOrder: _onOrderShipped,
  getOrderTimeline,
  getStatusCounts,
  mapLegacyStatus,
};
