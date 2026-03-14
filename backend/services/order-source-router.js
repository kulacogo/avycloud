'use strict';

/**
 * order-source-router.js — Routes order operations to native OMS.
 *
 * Uses AvyCloud OMS state machine (eBay/Kaufland direct).
 */

const { Firestore } = require('@google-cloud/firestore');

let _db;
function getDb() {
  if (!_db) _db = new Firestore();
  return _db;
}

/**
 * Determine the active order source.
 * @returns {'native'}
 */
function getOrderSource() {
  return 'native';
}

/**
 * Check if native OMS is active.
 * @returns {boolean}
 */
function isNativeOms() {
  return true;
}

/**
 * Sync orders from eBay + Kaufland directly.
 *
 * @returns {Promise<any[]>} orders
 */
async function syncOrders() {
  return syncOrdersNative();
}

/**
 * Native order sync: pull from eBay + Kaufland APIs.
 * @returns {Promise<any[]>}
 */
async function syncOrdersNative() {
  const results = [];

  // Sync eBay
  try {
    const { syncEbayOrders } = require('./order-intake-ebay');
    const ebayResult = await syncEbayOrders({ tenantId: 'default', lookbackDays: 7 });
    results.push({ source: 'ebay', ...ebayResult });
  } catch (err) {
    console.error(`[order-source-router] eBay sync failed: ${err.message}`);
    results.push({ source: 'ebay', error: err.message });
  }

  // Sync Kaufland
  try {
    const { syncKauflandOrders } = require('./order-intake-kaufland');
    const klResult = await syncKauflandOrders({ tenantId: 'default', lookbackDays: 7 });
    results.push({ source: 'kaufland', ...klResult });
  } catch (err) {
    console.error(`[order-source-router] Kaufland sync failed: ${err.message}`);
    results.push({ source: 'kaufland', error: err.message });
  }

  // Return orders from Firestore (freshly synced)
  const snap = await getDb().collection('orders')
    .orderBy('createdAt', 'desc')
    .limit(200)
    .get();

  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Mark an order as picked.
 *
 * Uses OMS state machine (pending/confirmed → picking → picked).
 *
 * @param {{ orderId: string, actor?: object }} opts
 * @returns {Promise<{ id: string }>}
 */
async function pickOrder({ orderId, actor }) {
  const { transitionOrder } = require('./order-state-machine');

  // Try picking first, then picked (two-step)
  const currentSnap = await getDb().collection('orders').doc(orderId).get();
  if (!currentSnap.exists) throw new Error('Order not found');
  const current = currentSnap.data();
  const omsStatus = current.omsStatus || current.status || 'pending';

  // If not already in 'picking', transition to 'picking' first
  if (omsStatus !== 'picking' && omsStatus !== 'picked') {
    await transitionOrder({
      orderId,
      toStatus: 'picking',
      actor: actor || { uid: 'system', email: 'api' },
      note: 'Kommissionierung gestartet',
    });
  }

  // Then transition to 'picked'
  if (omsStatus !== 'picked') {
    await transitionOrder({
      orderId,
      toStatus: 'picked',
      actor: actor || { uid: 'system', email: 'api' },
      note: 'Kommissionierung abgeschlossen',
    });
  }

  return { id: orderId };
}

/**
 * Mark an order as packed.
 *
 * Uses OMS state machine (picked → packing → packed).
 *
 * @param {{ orderId: string, actor?: object }} opts
 * @returns {Promise<{ id: string }>}
 */
async function packOrder({ orderId, actor }) {
  const { transitionOrder } = require('./order-state-machine');

  const currentSnap = await getDb().collection('orders').doc(orderId).get();
  if (!currentSnap.exists) throw new Error('Order not found');
  const current = currentSnap.data();
  const omsStatus = current.omsStatus || current.status || 'pending';

  // If in 'picked', transition to 'packed' (skipping 'packing' for quick pack)
  if (omsStatus !== 'packed') {
    await transitionOrder({
      orderId,
      toStatus: 'packed',
      actor: actor || { uid: 'system', email: 'api' },
      note: 'Verpackung abgeschlossen',
    });
  }

  return { id: orderId };
}

/**
 * Get dashboard order metrics.
 *
 * Aggregates from Firestore orders collection directly.
 *
 * @returns {Promise<object>}
 */
async function getDashboardOrderMetrics() {
  const db = getDb();
  const snap = await db.collection('orders')
    .select('omsStatus', 'status', 'totalAmount', 'currency', 'createdAt', 'source', 'marketplace')
    .limit(5000)
    .get();

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);

  let totalOrders = 0;
  let ordersToday = 0;
  let ordersMonth = 0;
  let revenueMonth = 0;
  let revenueYear = 0;
  const statusCounts = {};
  const marketplaceCounts = {};

  for (const doc of snap.docs) {
    const d = doc.data();
    const status = d.omsStatus || d.status || 'pending';
    const amount = d.totalAmount || 0;
    const created = d.createdAt ? new Date(d.createdAt) : null;
    const mp = d.marketplace || d.source || 'unknown';

    totalOrders++;
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    marketplaceCounts[mp] = (marketplaceCounts[mp] || 0) + 1;

    if (created) {
      if (created >= todayStart) ordersToday++;
      if (created >= monthStart) {
        ordersMonth++;
        revenueMonth += amount;
      }
      if (created >= yearStart) {
        revenueYear += amount;
      }
    }
  }

  return {
    totalOrders,
    ordersToday,
    ordersMonth,
    revenueMonth: Math.round(revenueMonth * 100) / 100,
    revenueYear: Math.round(revenueYear * 100) / 100,
    statusCounts,
    marketplaceCounts,
    source: 'native',
  };
}

module.exports = {
  getOrderSource,
  isNativeOms,
  syncOrders,
  pickOrder,
  packOrder,
  getDashboardOrderMetrics,
};
