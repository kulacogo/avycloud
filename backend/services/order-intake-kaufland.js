'use strict';

/**
 * order-intake-kaufland.js — Fetch orders directly from Kaufland API.
 *
 * Uses Kaufland Orders API to pull orders.
 * Replaces BaseLinker as order source for Kaufland.
 */

const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { kauflandRequest } = require('../lib/kaufland-api');
const { getNextNumber } = require('./number-sequence');

const ORDERS_COLLECTION = 'orders';

let _db;
function getDb() {
  if (!_db) _db = new Firestore();
  return _db;
}

/**
 * Fetch orders from Kaufland API.
 * @param {{ createdAfter?: string, status?: string, limit?: number, offset?: number, sort?: string }} opts
 * @returns {Promise<{ orders: object[], total: number }>}
 */
async function fetchKauflandOrders({
  createdAfter,
  status,
  limit = 100,
  offset = 0,
  sort = 'ts_created:desc',
} = {}) {
  const query = { limit, offset, sort };
  if (createdAfter) query.ts_created_from_iso = createdAfter;
  if (status) query.status = status;

  const result = await kauflandRequest('GET', '/v2/orders', { query });

  // Kaufland returns { data: [...], pagination: { total, limit, offset } }
  const data = result?.data || result;
  const orders = Array.isArray(data) ? data : [];
  const total = result?.pagination?.total || orders.length;

  return {
    orders: orders.map(mapKauflandOrder),
    total,
  };
}

/**
 * Fetch order units (line items) for a specific order.
 * @param {{ orderId: string }} opts
 * @returns {Promise<object[]>}
 */
async function fetchKauflandOrderUnits({ orderId }) {
  const result = await kauflandRequest('GET', `/v2/orders/${orderId}/units`);
  const data = result?.data || result;
  return Array.isArray(data) ? data : [];
}

/**
 * Map Kaufland API Order to AvyCloud order format.
 */
function mapKauflandOrder(klOrder) {
  const buyer = klOrder.buyer || {};
  const units = klOrder.order_units || [];

  const items = units.map((unit) => ({
    name: unit.product?.title || unit.offer_id || 'Unbekannter Artikel',
    sku: unit.id_offer || null,
    quantity: parseInt(unit.quantity || '1', 10),
    priceBrutto: parseFloat(unit.price || '0') / 100, // Kaufland prices in cents
    currency: 'EUR',
    unitId: unit.id_order_unit || null,
    ean: unit.ean || null,
    status: unit.status || null,
  }));

  const totalAmount = items.reduce((sum, item) => sum + (item.priceBrutto * item.quantity), 0);

  const shippingAddr = klOrder.buyer?.shipping_address || klOrder.shipping_address || {};

  return {
    marketplaceOrderId: String(klOrder.id_order || ''),
    source: 'kaufland',
    marketplace: 'kaufland',
    externalOrderId: String(klOrder.id_order || ''),
    createdAt: klOrder.ts_created || new Date().toISOString(),
    totalAmount,
    currency: 'EUR',
    customer: {
      name: [shippingAddr.first_name, shippingAddr.last_name].filter(Boolean).join(' ') || buyer.name || 'Unbekannt',
      street: [shippingAddr.street, shippingAddr.house_number].filter(Boolean).join(' ') || null,
      city: shippingAddr.city || null,
      zip: shippingAddr.postcode || null,
      country: shippingAddr.country || 'DE',
      phone: shippingAddr.phone || null,
      email: buyer.email || null,
    },
    items,
    paymentStatus: klOrder.payment_status || null,
    buyerNote: klOrder.note || null,
    raw: klOrder,
  };
}

/**
 * Map Kaufland order status to OMS status.
 * @param {string} klStatus
 * @returns {string}
 */
function mapKauflandStatus(klStatus) {
  const statusMap = {
    open: 'pending',
    open_new: 'pending',
    need_to_ship: 'confirmed',
    shipped: 'shipped',
    returned: 'returned',
    cancelled: 'cancelled',
    closed: 'completed',
  };
  return statusMap[klStatus] || 'pending';
}

/**
 * Sync Kaufland orders to Firestore.
 * Deduplicates by marketplaceOrderId.
 *
 * @param {{ tenantId?: string, lookbackDays?: number }} opts
 * @returns {Promise<{ synced: number, skipped: number, total: number }>}
 */
async function syncKauflandOrders({ tenantId = 'default', lookbackDays = 7 } = {}) {
  const from = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  let offset = 0;
  let totalSynced = 0;
  let totalSkipped = 0;
  let totalEntries = 0;
  const newOrderSkus = new Set();

  do {
    const result = await fetchKauflandOrders({
      createdAfter: from,
      limit: 100,
      offset,
    });

    totalEntries = result.total;

    for (const order of result.orders) {
      const saved = await saveOrderIfNew({ tenantId, order });
      if (saved) {
        totalSynced++;
        // Collect SKUs from newly imported orders for stock sync
        for (const item of (order.items || [])) {
          const sku = String(item.sku || '').trim();
          if (sku) newOrderSkus.add(sku);
        }
      } else {
        totalSkipped++;
      }
    }

    offset += result.orders.length;
    if (result.orders.length < 100) break;
  } while (offset < totalEntries && offset < 5000); // Safety limit

  // After importing new orders, push updated availability to marketplaces
  if (newOrderSkus.size > 0) {
    try {
      const { syncStockToAllChannels } = require('./stock-sync-dispatcher');
      const db = getDb();
      const skuArray = Array.from(newOrderSkus);
      for (let i = 0; i < skuArray.length; i += 10) {
        const chunk = skuArray.slice(i, i + 10);
        const snap = await db.collection('products_v2')
          .where('details.identifiers.sku', 'in', chunk)
          .get();
        for (const doc of snap.docs) {
          const product = { id: doc.id, ...doc.data() };
          syncStockToAllChannels({ tenantId, product, reason: 'kaufland-order-intake' })
            .catch((err) => console.warn(`[kaufland-intake] stock sync failed for ${doc.id}: ${err.message}`));
        }
      }
      console.log(`[kaufland-intake] triggered stock sync for ${newOrderSkus.size} SKUs from ${totalSynced} new orders`);
    } catch (err) {
      console.warn(`[kaufland-intake] stock sync after import failed: ${err.message}`);
    }
  }

  return { synced: totalSynced, skipped: totalSkipped, total: totalEntries };
}

/**
 * Save an order to Firestore if it doesn't already exist (by marketplace order ID).
 * @param {{ tenantId: string, order: object }} opts
 * @returns {Promise<boolean>} true if saved (new), false if skipped (duplicate)
 */
async function saveOrderIfNew({ tenantId, order }) {
  const db = getDb();
  const marketplaceKey = `${order.source}__${order.marketplaceOrderId}`;

  // Check for existing order by marketplace key
  const existing = await db.collection(ORDERS_COLLECTION)
    .where('marketplaceKey', '==', marketplaceKey)
    .limit(1)
    .get();

  if (!existing.empty) return false;

  // Generate AvyCloud order number
  const seq = await getNextNumber({ tenantId, type: 'order' });

  const doc = {
    tenantId,
    orderId: seq.formatted,
    marketplaceKey,
    marketplaceOrderId: order.marketplaceOrderId,
    externalOrderId: order.externalOrderId,
    source: order.source,
    marketplace: order.marketplace,
    omsStatus: 'pending',
    omsStatusLabel: 'Neu',
    // Legacy compatibility
    status: 'new',
    statusLabel: 'Neue Bestellung',
    createdAt: order.createdAt,
    updatedAt: new Date().toISOString(),
    totalAmount: order.totalAmount,
    currency: order.currency,
    customer: order.customer,
    items: order.items.map((item, idx) => ({
      id: `${seq.formatted}-${idx + 1}`,
      ...item,
    })),
    paymentStatus: order.paymentStatus,
    buyerNote: order.buyerNote,
  };

  await db.collection(ORDERS_COLLECTION).add(doc);
  return true;
}

module.exports = {
  fetchKauflandOrders,
  fetchKauflandOrderUnits,
  mapKauflandOrder,
  mapKauflandStatus,
  syncKauflandOrders,
  saveOrderIfNew,
};
