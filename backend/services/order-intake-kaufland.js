'use strict';

/**
 * order-intake-kaufland.js — Fetch orders directly from Kaufland API.
 *
 * Uses Kaufland Orders API to pull orders.
 * Fetches orders directly from Kaufland API.
 */

const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { kauflandRequest } = require('../lib/kaufland-api');
const { sanitizeText, validateEmail } = require('../lib/html-entities');
const { getNextNumber } = require('./number-sequence');
const { reserveStock } = require('./stock-reservation');
const { emitSyncEvent } = require('./sync-event-bus');

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
  // Kaufland rejects ISO dates with milliseconds — strip them
  if (createdAfter) query.ts_created_from_iso = String(createdAfter).replace(/\.\d{3}Z$/, 'Z');
  if (status) query.status = status;

  const result = await kauflandRequest('GET', '/orders', { query });

  // Kaufland list: double-nested { data: { data: [...], pagination: {...} } }
  const inner = result?.data?.data || result?.data || result;
  const rawOrders = Array.isArray(inner) ? inner : [];
  const total = result?.data?.pagination?.total || result?.pagination?.total || rawOrders.length;

  // The list endpoint may return orders without embedded order_units/buyer.
  // Enrich any order that is missing items or buyer by fetching its full detail.
  const orders = await Promise.all(rawOrders.map(async (klOrder) => {
    const hasUnits = Array.isArray(klOrder.order_units) && klOrder.order_units.length > 0;
    const hasBuyer = klOrder.buyer && (klOrder.buyer.email || klOrder.buyer.name
      || klOrder.buyer.shipping_address?.last_name);
    if (hasUnits && hasBuyer) return mapKauflandOrder(klOrder);
    // Fetch full order detail to get buyer + order_units
    try {
      const detailResult = await kauflandRequest('GET', `/orders/${klOrder.id_order}`);
      const full = detailResult?.data?.data || detailResult?.data || detailResult;
      if (full && (full.order_units || full.buyer)) return mapKauflandOrder({ ...klOrder, ...full });
    } catch (err) {
      console.warn(`[kaufland] Detail fetch failed for ${klOrder.id_order}: ${err.message}`);
    }
    return mapKauflandOrder(klOrder);
  }));

  return { orders, total };
}

/**
 * Fetch order units (line items) for a specific order.
 * @param {{ orderId: string }} opts
 * @returns {Promise<object[]>}
 */
async function fetchKauflandOrderUnits({ orderId }) {
  // Kaufland embeds order_units in the order response; there is no separate /units endpoint
  // API returns double-nested: { data: { data: { order_units: [...] } } }
  const result = await kauflandRequest('GET', `/orders/${orderId}`);
  const order = result?.data?.data || result?.data || result;
  const units = order?.order_units || [];
  return Array.isArray(units) ? units : [];
}

/**
 * Map Kaufland API Order to AvyCloud order format.
 */
function mapKauflandOrder(klOrder) {
  const buyer = klOrder.buyer || {};
  const units = klOrder.order_units || [];

  const items = units.map((unit) => ({
    name: sanitizeText(unit.product?.title) || unit.offer_id || 'Unbekannter Artikel',
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
  const billingAddr = klOrder.buyer?.billing_address || klOrder.billing_address || {};

  // Kaufland is prepaid — if payment_status is complete, the buyer paid at order creation
  const paymentStatus = klOrder.payment_status || null;
  const paidAt = paymentStatus === 'complete' ? (klOrder.ts_created || null) : null;

  // Derive shippedAt from unit status if any unit is shipped (API uses 'sent' or 'shipped')
  const anyShipped = units.some((u) => u.status === 'sent' || u.status === 'shipped');
  const shippedAt = anyShipped ? (klOrder.ts_updated_iso || klOrder.ts_updated || new Date().toISOString()) : null;

  // Shipping cost: Kaufland may include shipping_costs at unit level
  const shippingCost = units.reduce((sum, u) => {
    const sc = parseFloat(u.shipping_costs_total || u.shipping_cost || '0');
    return sum + (isNaN(sc) ? 0 : sc / 100); // cents → EUR
  }, 0) || null;

  // Extract tracking from units — Kaufland stores tracking per unit
  const shippedUnit = units.find((u) => u.tracking_number || u.carrier);
  const trackingNumber = shippedUnit?.tracking_number || klOrder.tracking_number || null;
  const carrier = shippedUnit?.carrier || klOrder.carrier || null;

  return {
    marketplaceOrderId: String(klOrder.id_order || ''),
    source: 'kaufland',
    marketplace: 'kaufland',
    externalOrderId: String(klOrder.id_order || ''),
    createdAt: klOrder.ts_created_iso || klOrder.ts_created || new Date().toISOString(),
    totalAmount,
    currency: 'EUR',
    customer: {
      name: sanitizeText([shippingAddr.first_name, shippingAddr.last_name].filter(Boolean).join(' '))
        || sanitizeText([billingAddr.first_name, billingAddr.last_name].filter(Boolean).join(' '))
        || sanitizeText(buyer.name) || 'Unbekannt',
      street: sanitizeText([shippingAddr.street, shippingAddr.house_number].filter(Boolean).join(' '))
        || sanitizeText([billingAddr.street, billingAddr.house_number].filter(Boolean).join(' '))
        || null,
      city: sanitizeText(shippingAddr.city) || sanitizeText(billingAddr.city) || null,
      zip: (shippingAddr.postcode || billingAddr.postcode) != null ? String(shippingAddr.postcode || billingAddr.postcode).trim() : null,
      country: shippingAddr.country || billingAddr.country || 'DE',
      phone: shippingAddr.phone || billingAddr.phone || buyer.phone || null,
      email: validateEmail(buyer.email),
    },
    billingAddress: {
      name: [billingAddr.first_name, billingAddr.last_name].filter(Boolean).join(' ')
        || [shippingAddr.first_name, shippingAddr.last_name].filter(Boolean).join(' ')
        || buyer.name || null,
      street: [billingAddr.street, billingAddr.house_number].filter(Boolean).join(' ')
        || [shippingAddr.street, shippingAddr.house_number].filter(Boolean).join(' ')
        || null,
      city: billingAddr.city || shippingAddr.city || null,
      zip: (billingAddr.postcode || shippingAddr.postcode) != null ? String(billingAddr.postcode || shippingAddr.postcode).trim() : null,
      country: billingAddr.country || shippingAddr.country || 'DE',
    },
    items,
    paymentStatus,
    paidAt,
    shippedAt,
    paymentMethod: paymentStatus === 'complete' ? 'Kaufland Checkout' : null,
    shippingCost: shippingCost || null,
    trackingNumber,
    carrier,
    buyerNote: sanitizeText(klOrder.note) || null,
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
    // Kaufland order-level statuses
    need_to_ship: 'confirmed',
    shipped: 'shipped',
    // Kaufland unit-level statuses (actual API field values)
    need_to_be_sent: 'confirmed',
    sent: 'shipped',
    // Other statuses
    returned: 'returned',
    cancelled: 'cancelled',
    closed: 'cancelled',  // Kaufland 'closed' = account/order closed, NOT fulfilled
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
  const newOrders = [];

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
        newOrders.push(order);
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

  // Reserve stock for newly imported orders
  for (const order of newOrders) {
    try {
      const orderId = `kaufland__${order.marketplaceOrderId}`;
      const items = (order.items || []).map((item) => ({
        sku: item.sku || null,
        quantity: item.quantity || 1,
      }));
      await reserveStock({ tenantId, orderId, items });
    } catch (err) {
      console.warn(`[kaufland-intake] reserveStock failed for ${order.marketplaceOrderId}: ${err.message}`);
    }
  }

  // After importing new orders, push updated availability to marketplaces (with retry)
  if (newOrderSkus.size > 0) {
    try {
      const { syncStockWithRetry } = require('./stock-sync-dispatcher');
      const db = getDb();
      const skuArray = Array.from(newOrderSkus);
      for (let i = 0; i < skuArray.length; i += 10) {
        const chunk = skuArray.slice(i, i + 10);
        const snap = await db.collection('products_v2')
          .where('details.identifiers.sku', 'in', chunk)
          .get();
        for (const doc of snap.docs) {
          const product = { id: doc.id, ...doc.data() };
          syncStockWithRetry({ tenantId, product, reason: 'kaufland-order-intake' })
            .catch((err) => console.warn(`[kaufland-intake] stock sync failed for ${doc.id}: ${err.message}`));
        }
      }
      console.log(`[kaufland-intake] triggered stock sync for ${newOrderSkus.size} SKUs from ${totalSynced} new orders`);
    } catch (err) {
      console.warn(`[kaufland-intake] stock sync after import failed: ${err.message}`);
    }
  }

  // Event-driven: emit for each new order so downstream syncs fire
  for (const order of newOrders) {
    emitSyncEvent('order:created', {
      entityId: `kaufland__${order.marketplaceOrderId}`,
      tenantId,
      source: 'kaufland-intake',
    });
  }

  // --- Status reconciliation: re-fetch recent orders to pick up status changes (cancelled, shipped, etc.) ---
  try {
    const reconcileDays = parseInt(process.env.RECONCILIATION_MAX_AGE_DAYS || '30', 10);
    const reconcileFrom = new Date(Date.now() - reconcileDays * 24 * 60 * 60 * 1000).toISOString();
    let recOffset = 0;
    let recUpdated = 0;
    let recTotal = 0;
    do {
      const result = await fetchKauflandOrders({ createdAfter: reconcileFrom, limit: 100, offset: recOffset });
      recTotal = result.total;
      for (const order of result.orders) {
        // saveOrderIfNew now also updates status of existing orders
        await saveOrderIfNew({ tenantId, order });
      }
      recOffset += result.orders.length;
      if (result.orders.length < 100) break;
    } while (recOffset < recTotal && recOffset < 3000);
    console.log(`[kaufland-intake] Status reconciliation: checked ${Math.min(recOffset, recTotal)} orders (30d lookback)`);
  } catch (err) {
    console.warn(`[kaufland-intake] Status reconciliation failed: ${err.message}`);
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
  let existing = await db.collection(ORDERS_COLLECTION)
    .where('marketplaceKey', '==', marketplaceKey)
    .limit(1)
    .get();

  // Fallback: old orders (pre-migration) have marketplaceOrderId but no marketplaceKey
  if (existing.empty && order.marketplaceOrderId) {
    existing = await db.collection(ORDERS_COLLECTION)
      .where('marketplaceOrderId', '==', String(order.marketplaceOrderId))
      .where('marketplace', '==', order.marketplace)
      .limit(1)
      .get();
    if (!existing.empty) {
      existing.docs[0].ref.update({ marketplaceKey }).catch(() => {});
    }
  }

  // Fallback: old BaseLinker imports have no marketplaceOrderId — match by createdAt + marketplace
  if (existing.empty && order.createdAt && order.marketplace) {
    existing = await db.collection(ORDERS_COLLECTION)
      .where('createdAt', '==', order.createdAt)
      .where('marketplace', '==', order.marketplace)
      .limit(1)
      .get();
    if (!existing.empty) {
      existing.docs[0].ref.update({ marketplaceKey, marketplaceOrderId: String(order.marketplaceOrderId) }).catch(() => {});
    }
  }

  if (!existing.empty) {
    // Order exists — reconcile status if Kaufland reports a more advanced state
    const existingDoc = existing.docs[0];
    const existingData = existingDoc.data();

    // Get Kaufland unit status: prefer mapped items (always available), fallback to raw
    let klUnitStatus = (order.items || [])[0]?.status || null;
    if (!klUnitStatus) {
      const rawUnits = order.raw?.order_units || [];
      klUnitStatus = rawUnits[0]?.status || null;
    }

    // If still no status, fetch units directly from Kaufland API
    if (!klUnitStatus) {
      try {
        const units = await fetchKauflandOrderUnits({ orderId: order.marketplaceOrderId });
        klUnitStatus = units[0]?.status || null;
      } catch (err) {
        console.warn(`[kaufland-intake] Failed to fetch units for ${order.marketplaceOrderId}: ${err.message}`);
      }
    }

    if (klUnitStatus) {
      const mappedStatus = mapKauflandStatus(klUnitStatus);
      const currentOms = existingData.omsStatus || existingData.status;

      // Rank-based check to prevent status downgrades (like eBay reconciliation)
      const OMS_RANK = {
        pending: 0, confirmed: 1, picking: 2, picked: 3, packing: 4,
        packed: 5, shipped: 6, delivered: 7, completed: 8, cancelled: 9, returned: 10,
      };
      const currentRank = OMS_RANK[currentOms] ?? 0;
      const newRank = OMS_RANK[mappedStatus] ?? 0;

      // Update if marketplace has more advanced status OR it's a cancellation
      if (mappedStatus !== currentOms && (newRank > currentRank || mappedStatus === 'cancelled')) {
        const OMS_STATUS_LABELS = {
          pending: 'Neu', confirmed: 'Bestätigt', picking: 'Kommissionierung',
          picked: 'Kommissioniert', packing: 'Verpackung', packed: 'Verpackt',
          shipped: 'Versendet', delivered: 'Zugestellt', cancelled: 'Storniert',
          returned: 'Retoure', completed: 'Abgeschlossen', on_hold: 'Pausiert',
        };
        const updateFields = {
          omsStatus: mappedStatus,
          omsStatusLabel: OMS_STATUS_LABELS[mappedStatus] || mappedStatus,
          status: mappedStatus,
          statusLabel: OMS_STATUS_LABELS[mappedStatus] || mappedStatus,
          updatedAt: new Date().toISOString(),
          'ops.kauflandStatusSync': { from: currentOms, to: mappedStatus, klUnitStatus, syncedAt: new Date().toISOString() },
        };
        // Backfill shippedAt when marketplace confirms shipment
        if (mappedStatus === 'shipped' && !existingData.shippedAt) {
          updateFields.shippedAt = new Date().toISOString();
        }
        // Backfill paidAt if payment is complete and not yet recorded
        if (order.paidAt && !existingData.paidAt) {
          updateFields.paidAt = order.paidAt;
        }
        if (order.paymentMethod && !existingData.paymentMethod) {
          updateFields.paymentMethod = order.paymentMethod;
        }
        await existingDoc.ref.update(updateFields);
        console.log(`[kaufland-intake] Status updated: ${existingData.orderId || existingDoc.id} ${currentOms} → ${mappedStatus} (Kaufland: ${klUnitStatus})`);
      }

      // Also backfill unitIds if missing (critical for tracking/cancel push)
      const existingItems = existingData.items || [];
      const hasUnitIds = existingItems.some((item) => item.unitId);
      if (!hasUnitIds && (order.items || []).some((item) => item.unitId)) {
        const updatedItems = existingItems.map((item, idx) => ({
          ...item,
          unitId: item.unitId || (order.items[idx] ? order.items[idx].unitId : null),
        }));
        await existingDoc.ref.update({ items: updatedItems });
        console.log(`[kaufland-intake] Backfilled unitIds for ${existingData.orderId || existingDoc.id}`);
      }

      // Backfill missing customer/items data (list endpoint may have saved an empty order)
      const needsCustomer = !existingData.customer?.name || existingData.customer.name === 'Unbekannt';
      const needsItems = !existingData.items || existingData.items.length === 0;
      const hasNewCustomer = order.customer?.name && order.customer.name !== 'Unbekannt';
      const hasNewItems = order.items && order.items.length > 0;
      if ((needsCustomer && hasNewCustomer) || (needsItems && hasNewItems)) {
        const backfill = {};
        if (needsCustomer && hasNewCustomer) backfill.customer = order.customer;
        if (needsItems && hasNewItems) {
          backfill.items = order.items.map((item, idx) => ({
            id: `${existingData.orderId || existingDoc.id}-${idx + 1}`,
            ...item,
          }));
          backfill.totalAmount = order.totalAmount;
          if (order.billingAddress) backfill.billingAddress = order.billingAddress;
        }
        await existingDoc.ref.update(backfill);
        console.log(`[kaufland-intake] Backfilled customer/items for ${existingData.orderId || existingDoc.id}`);
      }
    }
    return false;
  }

  // Generate AvyCloud order number
  const seq = await getNextNumber({ tenantId, type: 'order' });

  // Determine initial OMS status from Kaufland unit status
  const klUnitStatus = (order.items || [])[0]?.status || null;
  const initialStatus = klUnitStatus ? mapKauflandStatus(klUnitStatus) : 'pending';
  const OMS_STATUS_LABELS = {
    pending: 'Neu', confirmed: 'Bestätigt', picking: 'Kommissionierung',
    picked: 'Kommissioniert', packing: 'Verpackung', packed: 'Verpackt',
    shipped: 'Versendet', delivered: 'Zugestellt', cancelled: 'Storniert',
    returned: 'Retoure', completed: 'Abgeschlossen', on_hold: 'Pausiert',
  };

  const doc = {
    tenantId,
    orderId: seq.formatted,
    marketplaceKey,
    marketplaceOrderId: order.marketplaceOrderId,
    externalOrderId: order.externalOrderId,
    source: order.source,
    marketplace: order.marketplace,
    omsStatus: initialStatus,
    omsStatusLabel: OMS_STATUS_LABELS[initialStatus] || 'Neu',
    status: initialStatus,
    statusLabel: OMS_STATUS_LABELS[initialStatus] || 'Neu',
    createdAt: order.createdAt,
    updatedAt: new Date().toISOString(),
    totalAmount: order.totalAmount,
    currency: order.currency,
    customer: order.customer,
    billingAddress: order.billingAddress || null,
    items: order.items.map((item, idx) => ({
      id: `${seq.formatted}-${idx + 1}`,
      ...item,
    })),
    paymentStatus: order.paymentStatus,
    paidAt: order.paidAt || null,
    shippedAt: order.shippedAt || null,
    paymentMethod: order.paymentMethod || null,
    shippingCost: order.shippingCost || null,
    buyerNote: order.buyerNote,
  };

  // Use marketplaceKey as doc ID for idempotent creation (prevents duplicates on race condition)
  await db.collection(ORDERS_COLLECTION).doc(marketplaceKey).set(doc);
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
