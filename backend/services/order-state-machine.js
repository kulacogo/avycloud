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

  return result;
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
  // For large datasets, use a counters document pattern
  const snap = await getDb()
    .collection(ORDERS_COLLECTION)
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
    // Map old BaseLinker statuses to OMS statuses
    const mapped = mapLegacyStatus(status);
    counts[mapped] = (counts[mapped] || 0) + 1;
  }

  return counts;
}

/**
 * Map legacy BaseLinker status to OMS status.
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
  getOrderTimeline,
  getStatusCounts,
  mapLegacyStatus,
};
