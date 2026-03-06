/**
 * Stock Reservation Service
 *
 * Manages stock reservations when orders come in (soft-lock).
 * Prevents overselling by reserving stock before warehouse picking.
 *
 * Flow: Order received → reserveStock() → Picking → confirmReservation() (= stock-out)
 *       If order cancelled → releaseReservation()
 *
 * Collection: stock_reservations
 * Doc: { tenantId, orderId, sku, productId, quantity, status, createdAt, expiresAt }
 */

const { firestore } = require('../lib/firestore');

const RESERVATIONS_COLLECTION = 'stock_reservations';
const DEFAULT_EXPIRY_HOURS = parseInt(process.env.STOCK_RESERVATION_EXPIRY_HOURS || '72', 10);

/**
 * Reserve stock for an order's items.
 * Idempotent: if reservations for this orderId already exist, skip.
 *
 * @param {Object} params
 * @param {string} params.tenantId - Tenant ID (default: 'default')
 * @param {string} params.orderId - Unique order identifier
 * @param {Array<{sku: string, productId?: string, quantity: number}>} params.items
 * @returns {Object} { reserved: boolean, count: number, skipped: boolean }
 */
async function reserveStock({ tenantId = 'default', orderId, items }) {
  if (!orderId) throw new Error('orderId is required for stock reservation');
  if (!Array.isArray(items) || items.length === 0) {
    return { reserved: false, count: 0, skipped: true, reason: 'no items' };
  }

  // Idempotency check: if reservations for this order already exist, skip
  const existingSnap = await firestore.collection(RESERVATIONS_COLLECTION)
    .where('orderId', '==', orderId)
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'reserved')
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    return { reserved: false, count: 0, skipped: true, reason: 'already reserved' };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + DEFAULT_EXPIRY_HOURS * 60 * 60 * 1000);
  const batch = firestore.batch();
  let count = 0;

  for (const item of items) {
    if (!item.sku && !item.productId) continue;
    const qty = Number(item.quantity) || 0;
    if (qty <= 0) continue;

    const ref = firestore.collection(RESERVATIONS_COLLECTION).doc();
    batch.set(ref, {
      tenantId,
      orderId,
      sku: item.sku || null,
      productId: item.productId || null,
      quantity: qty,
      status: 'reserved',
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    count++;
  }

  if (count > 0) {
    await batch.commit();
  }

  return { reserved: count > 0, count, skipped: false };
}

/**
 * Release all reservations for an order (e.g., cancellation).
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.orderId
 * @returns {Object} { released: number }
 */
async function releaseReservation({ tenantId = 'default', orderId }) {
  if (!orderId) throw new Error('orderId is required');

  const snap = await firestore.collection(RESERVATIONS_COLLECTION)
    .where('orderId', '==', orderId)
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'reserved')
    .get();

  if (snap.empty) return { released: 0 };

  const batch = firestore.batch();
  snap.docs.forEach((doc) => {
    batch.update(doc.ref, {
      status: 'released',
      releasedAt: new Date().toISOString(),
    });
  });
  await batch.commit();

  return { released: snap.docs.length };
}

/**
 * Confirm reservations for an order (= stock-out happened).
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.orderId
 * @returns {Object} { confirmed: number }
 */
async function confirmReservation({ tenantId = 'default', orderId }) {
  if (!orderId) throw new Error('orderId is required');

  const snap = await firestore.collection(RESERVATIONS_COLLECTION)
    .where('orderId', '==', orderId)
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'reserved')
    .get();

  if (snap.empty) return { confirmed: 0 };

  const batch = firestore.batch();
  snap.docs.forEach((doc) => {
    batch.update(doc.ref, {
      status: 'confirmed',
      confirmedAt: new Date().toISOString(),
    });
  });
  await batch.commit();

  return { confirmed: snap.docs.length };
}

/**
 * Get total reserved quantity for a given SKU or productId.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} [params.sku]
 * @param {string} [params.productId]
 * @returns {number} Total reserved quantity
 */
async function getReservedQuantity({ tenantId = 'default', sku, productId }) {
  let query = firestore.collection(RESERVATIONS_COLLECTION)
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'reserved');

  if (sku) {
    query = query.where('sku', '==', sku);
  } else if (productId) {
    query = query.where('productId', '==', productId);
  } else {
    return 0;
  }

  const snap = await query.get();
  let total = 0;
  snap.docs.forEach((doc) => {
    total += Number(doc.data().quantity) || 0;
  });
  return total;
}

/**
 * Get all active reservations for a tenant, optionally filtered.
 *
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} [params.status] - 'reserved', 'confirmed', 'released'
 * @param {number} [params.limit]
 * @returns {Array}
 */
async function listReservations({ tenantId = 'default', status, limit = 200 }) {
  let query = firestore.collection(RESERVATIONS_COLLECTION)
    .where('tenantId', '==', tenantId);

  if (status) {
    query = query.where('status', '==', status);
  }

  query = query.orderBy('createdAt', 'desc').limit(limit);
  const snap = await query.get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

/**
 * Clean up expired reservations (best-effort, run periodically).
 *
 * @param {Object} [params]
 * @param {string} [params.tenantId]
 * @returns {Object} { expired: number }
 */
async function expireStaleReservations({ tenantId } = {}) {
  const now = new Date().toISOString();
  let query = firestore.collection(RESERVATIONS_COLLECTION)
    .where('status', '==', 'reserved')
    .where('expiresAt', '<', now)
    .limit(500);

  if (tenantId) {
    query = query.where('tenantId', '==', tenantId);
  }

  const snap = await query.get();
  if (snap.empty) return { expired: 0 };

  const batch = firestore.batch();
  snap.docs.forEach((doc) => {
    batch.update(doc.ref, {
      status: 'expired',
      expiredAt: now,
    });
  });
  await batch.commit();

  return { expired: snap.docs.length };
}

module.exports = {
  reserveStock,
  releaseReservation,
  confirmReservation,
  getReservedQuantity,
  listReservations,
  expireStaleReservations,
};
