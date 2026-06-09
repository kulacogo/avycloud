'use strict';

/**
 * order-intake-ebay.js — Fetch orders directly from eBay Trading API.
 *
 * Uses GetOrders Trading API call to pull orders.
 * Fetches orders directly from eBay Trading API.
 */

const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { callTradingApi } = require('../lib/ebay-trading-api');
const { sanitizeText, validateEmail } = require('../lib/html-entities');
const { parsePackstation } = require('../lib/packstation');
const { getNextNumber } = require('./number-sequence');
const { reserveStock } = require('./stock-reservation');
const { syncStockWithRetry, findProductsBySkuChunk } = require('./stock-sync-dispatcher');
const { emitSyncEvent } = require('./sync-event-bus');
const productStore = require('../lib/product-store');

const ORDERS_COLLECTION = 'orders';

let _db;
function getDb() {
  if (!_db) _db = new Firestore();
  return _db;
}

/**
 * Fetch orders from eBay via Trading API GetOrders.
 * @param {{ createTimeFrom?: string, createTimeTo?: string, pageNumber?: number, entriesPerPage?: number, orderRole?: string, orderStatus?: string }} opts
 * @returns {Promise<{ orders: object[], totalPages: number, totalEntries: number }>}
 */
async function fetchEbayOrders({
  createTimeFrom,
  createTimeTo,
  pageNumber = 1,
  entriesPerPage = 50,
  orderRole = 'Seller',
  orderStatus = 'All',
} = {}) {
  // Default: last 7 days
  const now = new Date();
  const from = createTimeFrom || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const to = createTimeTo || now.toISOString();

  const innerXml = `
    <CreateTimeFrom>${from}</CreateTimeFrom>
    <CreateTimeTo>${to}</CreateTimeTo>
    <OrderRole>${orderRole}</OrderRole>
    <OrderStatus>${orderStatus}</OrderStatus>
    <Pagination>
      <EntriesPerPage>${entriesPerPage}</EntriesPerPage>
      <PageNumber>${pageNumber}</PageNumber>
    </Pagination>
  `;

  const result = await callTradingApi('GetOrders', innerXml, { timeoutMs: 30000 });
  const resp = result.response;

  // Check for eBay API errors (HTTP 200 can still contain errors)
  const ack = resp?.Ack || '';
  if (ack === 'Failure') {
    const errors = Array.isArray(resp.Errors) ? resp.Errors : resp.Errors ? [resp.Errors] : [];
    const msgs = errors.map((e) => `${e.ErrorCode}: ${e.ShortMessage || e.LongMessage}`).join('; ');
    throw new Error(`eBay GetOrders failed (Ack=Failure): ${msgs}`);
  }
  if (ack === 'Warning' && resp.Errors) {
    const errors = Array.isArray(resp.Errors) ? resp.Errors : [resp.Errors];
    const msgs = errors.map((e) => `${e.ErrorCode}: ${e.ShortMessage || e.LongMessage}`).join('; ');
    console.warn(`[ebay-intake] GetOrders warnings: ${msgs}`);
  }

  // Parse orders from response
  const orderArray = resp?.OrderArray?.Order;
  const orders = Array.isArray(orderArray) ? orderArray : orderArray ? [orderArray] : [];

  const totalPages = parseInt(resp?.PaginationResult?.TotalNumberOfPages || '1', 10);
  const totalEntries = parseInt(resp?.PaginationResult?.TotalNumberOfEntries || '0', 10);

  return {
    orders: orders.map(mapEbayOrder),
    totalPages,
    totalEntries,
  };
}

/**
 * Map eBay OrderStatus + CancelStatus to OMS status.
 * @param {object} ebayOrder
 * @returns {string}
 */
function mapEbayStatus(ebayOrder) {
  const cancelState = ebayOrder?.CancelStatus?.CancelState || '';
  if (cancelState === 'Cancelled' || cancelState === 'CancelComplete') return 'cancelled';
  if (cancelState === 'CancelPending') return 'cancelled';

  const orderStatus = ebayOrder?.OrderStatus || '';
  const shippedTime = ebayOrder?.ShippedTime;
  const checkoutComplete = ebayOrder?.CheckoutStatus?.Status === 'Complete';

  if (orderStatus === 'Cancelled') return 'cancelled';
  if (orderStatus === 'Completed' && shippedTime) return 'shipped';
  if (orderStatus === 'Completed' && checkoutComplete) return 'confirmed';
  if (orderStatus === 'Active' && checkoutComplete) return 'confirmed';

  // Unpaid orders → on_hold for visibility (eBay CheckoutStatus or PaymentHoldStatus)
  const paymentStatus = ebayOrder?.CheckoutStatus?.Status || '';
  if (paymentStatus === 'Incomplete' || orderStatus === 'Active') return 'on_hold';

  return 'pending';
}

/**
 * Map eBay Trading API Order to AvyCloud order format.
 */
// eBay sometimes returns placeholder strings instead of real contact info
const EBAY_JUNK_VALUES = new Set([
  'invalid request', 'invalid', 'n/a', 'none', 'null', 'undefined',
  'invalid request.', 'not available',
]);

function sanitizeContactField(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || EBAY_JUNK_VALUES.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

function mapEbayOrder(ebayOrder) {
  const transactions = ebayOrder?.TransactionArray?.Transaction;
  const txArray = Array.isArray(transactions) ? transactions : transactions ? [transactions] : [];

  const items = txArray.map((tx) => {
    // EAN: check VariationSpecifics (multi-variation) and ItemSpecifics (single-item)
    const variationSpecs = tx?.Variation?.VariationSpecifics?.NameValueList;
    const itemSpecs = tx?.Item?.ItemSpecifics?.NameValueList;
    const allSpecs = [
      ...(Array.isArray(variationSpecs) ? variationSpecs : variationSpecs ? [variationSpecs] : []),
      ...(Array.isArray(itemSpecs) ? itemSpecs : itemSpecs ? [itemSpecs] : []),
    ];
    const ean = allSpecs.find((nv) => nv?.Name === 'EAN')?.Value?.[0] || null;

    return {
      name: sanitizeText(tx?.Item?.Title) || 'Unbekannter Artikel',
      sku: tx?.Item?.SKU || tx?.Variation?.SKU || null,
      quantity: parseInt(tx?.QuantityPurchased || '1', 10),
      priceBrutto: parseFloat(tx?.TransactionPrice?.['#text'] || tx?.TransactionPrice || '0'),
      currency: tx?.TransactionPrice?.['@_currencyID'] || 'EUR',
      itemId: tx?.Item?.ItemID || null,
      transactionId: tx?.TransactionID || null,
      ean,
    };
  });

  const shippingAddr = ebayOrder?.ShippingAddress || {};
  const customerStreet = [shippingAddr?.Street1, shippingAddr?.Street2].filter(Boolean).map(sanitizeText).join(', ') || null;
  // DHL Packstation/Postfiliale: capture the Postnummer at intake so the
  // shipping label can be created without manual re-entry (see lib/packstation.js).
  const customerPostNumber = customerStreet ? parsePackstation(customerStreet).postNumber || null : null;
  const totalAmount = parseFloat(ebayOrder?.Total?.['#text'] || ebayOrder?.Total || '0');

  // Extract tracking from ShipmentTrackingDetails
  const shippingDetails = ebayOrder?.ShippingDetails?.ShipmentTrackingDetails;
  const trackingArray = Array.isArray(shippingDetails) ? shippingDetails : shippingDetails ? [shippingDetails] : [];
  const trackingNumber = trackingArray[0]?.ShipmentTrackingNumber || null;
  const carrier = trackingArray[0]?.ShippingCarrierUsed || null;

  return {
    marketplaceOrderId: ebayOrder?.OrderID || null,
    source: 'ebay',
    marketplace: 'ebay',
    externalOrderId: ebayOrder?.OrderID || null,
    ebayStatus: mapEbayStatus(ebayOrder),
    createdAt: ebayOrder?.CreatedTime || new Date().toISOString(),
    paidAt: ebayOrder?.PaidTime || null,
    shippedAt: ebayOrder?.ShippedTime || null,
    totalAmount,
    currency: ebayOrder?.Total?.['@_currencyID'] || 'EUR',
    customer: {
      name: sanitizeText(shippingAddr?.Name) || ebayOrder?.BuyerUserID || 'Unbekannt',
      street: customerStreet,
      city: sanitizeText(shippingAddr?.CityName) || null,
      zip: shippingAddr?.PostalCode != null ? String(shippingAddr.PostalCode).trim() : null,
      country: shippingAddr?.Country || null,
      phone: sanitizeContactField(shippingAddr?.Phone),
      email: validateEmail(sanitizeContactField(ebayOrder?.TransactionArray?.Transaction?.[0]?.Buyer?.Email)),
      postNumber: customerPostNumber,
    },
    items,
    paymentStatus: ebayOrder?.CheckoutStatus?.eBayPaymentStatus || ebayOrder?.PaymentStatus || null,
    paymentMethod: ebayOrder?.CheckoutStatus?.PaymentMethod || null,
    shippingService: ebayOrder?.ShippingServiceSelected?.ShippingService || null,
    shippingCost: parseFloat(ebayOrder?.ShippingServiceSelected?.ShippingServiceCost?.['#text'] || '0'),
    trackingNumber,
    carrier,
    buyerNote: sanitizeText(ebayOrder?.BuyerCheckoutMessage) || null,
    raw: ebayOrder,
  };
}

/**
 * Sync eBay orders to Firestore.
 * Deduplicates by marketplaceOrderId.
 *
 * @param {{ tenantId?: string, lookbackDays?: number }} opts
 * @returns {Promise<{ synced: number, skipped: number, total: number }>}
 */
async function syncEbayOrders({ tenantId = 'default', lookbackDays = 7 } = {}) {
  // eBay Trading API hard limit: CreateTimeFrom cannot be older than 90 days
  const cappedDays = Math.min(lookbackDays, 90);
  const now = new Date();
  const from = new Date(now.getTime() - cappedDays * 24 * 60 * 60 * 1000).toISOString();

  let page = 1;
  let totalSynced = 0;
  let totalSkipped = 0;
  let totalEntries = 0;
  const newOrderSkus = new Set();
  const newOrders = []; // Track newly saved orders for reservation

  do {
    const result = await fetchEbayOrders({
      createTimeFrom: from,
      createTimeTo: now.toISOString(),
      pageNumber: page,
      entriesPerPage: 100,
    });

    totalEntries = result.totalEntries;

    for (const order of result.orders) {
      const saved = await saveOrderIfNew({ tenantId, order });
      if (saved) {
        totalSynced++;
        newOrders.push(order);
        for (const item of (order.items || [])) {
          const sku = String(item.sku || '').trim();
          if (sku) newOrderSkus.add(sku);
        }

        // Reserve stock IMMEDIATELY after save — not after the loop
        try {
          const orderId = `ebay__${order.marketplaceOrderId}`;
          const items = (order.items || []).map((item) => ({
            sku: item.sku || null,
            quantity: item.quantity || 1,
          }));
          await reserveStock({ tenantId, orderId, items });
        } catch (err) {
          console.warn(`[ebay-intake] reserveStock failed for ${order.marketplaceOrderId}: ${err.message}`);
        }
      } else {
        totalSkipped++;
      }
    }

    page++;
    if (page > result.totalPages) break;
  } while (page <= 50); // Safety limit

  // Push updated availability to all marketplaces
  if (newOrderSkus.size > 0) {
    try {
      const skuArray = Array.from(newOrderSkus);
      for (let i = 0; i < skuArray.length; i += 10) {
        const chunk = skuArray.slice(i, i + 10);
        const products = await findProductsBySkuChunk(chunk);
        for (const product of products) {
          try {
            await syncStockWithRetry({ tenantId, product, reason: 'ebay-order-intake' });
          } catch (err) {
            console.warn(`[ebay-intake] stock sync failed for ${product.id}: ${err.message}`);
          }
        }
      }
      console.log(`[ebay-intake] completed stock sync for ${newOrderSkus.size} SKUs from ${totalSynced} new orders`);
    } catch (err) {
      console.warn(`[ebay-intake] stock sync after import failed: ${err.message}`);
    }
  }

  // Event-driven: emit for each new order so downstream syncs fire
  for (const order of newOrders) {
    emitSyncEvent('order:created', {
      entityId: `ebay__${order.marketplaceOrderId}`,
      tenantId,
      source: 'ebay-intake',
    });
  }

  // --- Status reconciliation: re-fetch recent orders to pick up status changes ---
  try {
    const reconcileDays = parseInt(process.env.RECONCILIATION_MAX_AGE_DAYS || '30', 10);
    const reconcileFrom = new Date(Date.now() - reconcileDays * 24 * 60 * 60 * 1000).toISOString();
    let recPage = 1;
    let recTotal = 0;
    let recChecked = 0;
    do {
      const result = await fetchEbayOrders({
        createTimeFrom: reconcileFrom,
        createTimeTo: now.toISOString(),
        pageNumber: recPage,
        entriesPerPage: 100,
      });
      recTotal = result.totalEntries;
      for (const order of result.orders) {
        await saveOrderIfNew({ tenantId, order });
        recChecked++;
      }
      recPage++;
      if (recPage > result.totalPages) break;
    } while (recPage <= 50);
    console.log(`[ebay-intake] Status reconciliation: checked ${recChecked} orders (14d lookback)`);
  } catch (err) {
    console.warn(`[ebay-intake] Status reconciliation failed: ${err.message}`);
  }

  return { synced: totalSynced, skipped: totalSkipped, total: totalEntries };
}

/**
 * Enrich order items with product weights from products_v2.
 * Returns enriched items + total order weight (null if any item has no weight).
 */
async function enrichOrderItemsWithWeight(items) {
  let allHaveWeight = true;
  const enriched = [];

  for (const item of items) {
    const weight = await productStore.getProductWeightBySku(item.sku || null, item.ean || null);
    if (weight) {
      enriched.push({ ...item, weight });
    } else {
      allHaveWeight = false;
      enriched.push(item);
    }
  }

  const orderWeight = allHaveWeight
    ? enriched.reduce((sum, item) => sum + (item.weight * (item.quantity || 1)), 0)
    : null;

  return { items: enriched, orderWeight };
}

/**
 * Save an order to Firestore if it doesn't already exist (by marketplace order ID).
 * @param {{ tenantId: string, order: object }} opts
 * @returns {Promise<boolean>} true if saved (new), false if skipped (duplicate)
 */
const OMS_STATUS_LABELS = {
  pending: 'Neu', confirmed: 'Bestätigt', picking: 'Kommissionierung',
  picked: 'Kommissioniert', packing: 'Verpackung', packed: 'Verpackt',
  shipped: 'Versendet', delivered: 'Zugestellt', cancelled: 'Storniert',
  returned: 'Retoure', completed: 'Abgeschlossen', on_hold: 'Pausiert',
};

async function saveOrderIfNew({ tenantId, order }) {
  const db = getDb();
  const marketplaceKey = `${order.source}__${order.marketplaceOrderId}`;

  // Check for existing order by marketplace key
  let existing = await db.collection(ORDERS_COLLECTION)
    .where('marketplaceKey', '==', marketplaceKey)
    .limit(1)
    .get();

  // Fallback: old orders have marketplaceOrderId but no marketplaceKey
  if (existing.empty && order.marketplaceOrderId) {
    existing = await db.collection(ORDERS_COLLECTION)
      .where('marketplaceOrderId', '==', String(order.marketplaceOrderId))
      .where('marketplace', '==', order.marketplace)
      .limit(1)
      .get();
    // Self-heal: write marketplaceKey so future lookups skip this fallback
    if (!existing.empty) {
      existing.docs[0].ref.update({ marketplaceKey }).catch(() => {});
    }
  }

  // Fallback: old imports have no marketplaceOrderId — match by createdAt + marketplace
  if (existing.empty && order.createdAt && order.marketplace) {
    existing = await db.collection(ORDERS_COLLECTION)
      .where('createdAt', '==', order.createdAt)
      .where('marketplace', '==', order.marketplace)
      .limit(1)
      .get();
    if (!existing.empty) {
      // Self-heal: write marketplaceKey and marketplaceOrderId to the old doc
      existing.docs[0].ref.update({ marketplaceKey, marketplaceOrderId: String(order.marketplaceOrderId) }).catch(() => {});
    }
  }

  if (!existing.empty) {
    // Order exists — reconcile status if eBay reports a more advanced state
    const existingDoc = existing.docs[0];
    const existingData = existingDoc.data();
    const ebayStatus = order.ebayStatus;
    const currentOms = existingData.omsStatus || existingData.status;

    // Only update if eBay reports a terminal/advanced status we don't have yet
    if (ebayStatus && ebayStatus !== currentOms && ['cancelled', 'shipped', 'confirmed', 'completed'].includes(ebayStatus)) {
      // Don't downgrade: don't go from shipped → confirmed
      // HARDEN-Wave-7 (2026-05-22): aus zentralem Helper (Sort-Order, nicht
      // Forward-Rank — wir vergleichen hier reine Pipeline-Position, nicht
      // Terminal-Block-Logik).
      const { getOmsSortOrder } = require('../lib/order-status-helpers');
      const currentRank = Math.max(0, getOmsSortOrder(currentOms));
      const newRank = Math.max(0, getOmsSortOrder(ebayStatus));

      if (newRank > currentRank || ebayStatus === 'cancelled') {
        if (ebayStatus === 'shipped') {
          // SHIPPED → State Machine nutzen (triggert Stock-Decrement via processShippedOrder)
          const { transitionOrder, processShippedOrder } = require('./order-state-machine');
          const transResult = await transitionOrder({
            tenantId, orderId: existingDoc.id,
            toStatus: 'shipped', force: true,
            actor: { uid: 'system', email: 'ebay-reconciliation' },
            note: `eBay Status-Sync: ${currentOms} → shipped`,
            timestamps: { shippedAt: order.shippedAt || new Date().toISOString() },
          }).catch((err) => {
            console.warn(`[ebay-intake] transitionOrder to shipped failed for ${existingDoc.id}: ${err.message}`);
            return { ok: false };
          });

          // Fallback: Wenn Transition fehlschlaegt (z.B. already shipped), trotzdem processShippedOrder aufrufen
          if (!transResult.ok) {
            await processShippedOrder({ orderId: existingDoc.id, tenantId })
              .catch((err) => console.warn(`[ebay-intake] processShippedOrder failed for ${existingDoc.id}: ${err.message}`));
          }

          // Tracking/shippedAt backfill (separate von Transition)
          const backfill = {};
          if (order.trackingNumber && !existingData.trackingNumber) {
            backfill.trackingNumber = order.trackingNumber;
            backfill.carrier = order.carrier;
          }
          if (order.shippedAt && !existingData.shippedAt) {
            backfill.shippedAt = order.shippedAt;
          }
          if (Object.keys(backfill).length > 0) {
            await existingDoc.ref.update(backfill);
          }
          console.log(`[ebay-intake] Status updated via state machine: ${existingData.orderId || existingDoc.id} ${currentOms} → shipped`);
        } else {
          // Andere Status (confirmed, cancelled, completed) — IMMER ueber state machine laufen
          // lassen, damit order:status_changed emittiert wird und _onOrderCancelled/etc. laufen.
          // Siehe CLAUDE.md Punkt 11 (kein omsStatus-Direct-Write).
          const { transitionOrder } = require('./order-state-machine');
          const transResult = await transitionOrder({
            tenantId, orderId: existingDoc.id,
            toStatus: ebayStatus, force: true,
            actor: { uid: 'system', email: 'ebay-reconciliation' },
            note: `eBay Status-Sync: ${currentOms} → ${ebayStatus}`,
          }).catch((err) => {
            console.warn(`[ebay-intake] transitionOrder to ${ebayStatus} failed for ${existingDoc.id}: ${err.message}`);
            return { ok: false };
          });

          // Backfill-Only Updates (tracking, shippedAt, ops.ebayStatusSync) — separat,
          // denn transitionOrder setzt diese Felder nicht.
          const backfill = {
            'ops.ebayStatusSync': { from: currentOms, to: ebayStatus, syncedAt: new Date().toISOString() },
          };
          if (order.trackingNumber && !existingData.trackingNumber) {
            backfill.trackingNumber = order.trackingNumber;
            backfill.carrier = order.carrier;
          }
          if (order.shippedAt && !existingData.shippedAt) {
            backfill.shippedAt = order.shippedAt;
          }
          await existingDoc.ref.update(backfill).catch((err) => {
            console.warn(`[ebay-intake] backfill update failed for ${existingDoc.id}: ${err.message}`);
          });

          // Legacy-Fallback fuer cancelled: wenn transition fehlschlaegt, direkt _onOrderCancelled
          if (!transResult.ok && ebayStatus === 'cancelled') {
            try {
              const { processCancelledOrder } = require('./order-state-machine');
              if (typeof processCancelledOrder === 'function') {
                await processCancelledOrder({ orderId: existingDoc.id, tenantId });
              }
            } catch (err) {
              console.warn(`[ebay-intake] processCancelledOrder fallback failed for ${existingDoc.id}: ${err.message}`);
            }
          }

          console.log(`[ebay-intake] Status updated via state machine: ${existingData.orderId || existingDoc.id} ${currentOms} → ${ebayStatus}`);
        }
      }
    }
    return false;
  }

  // Generate AvyCloud order number
  const seq = await getNextNumber({ tenantId, type: 'order' });

  // Enrich items with product weights
  const { items: enrichedItems, orderWeight } = await enrichOrderItemsWithWeight(order.items);

  const initialStatus = order.ebayStatus || 'pending';

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
    paidAt: order.paidAt || null,
    shippedAt: order.shippedAt || null,
    updatedAt: new Date().toISOString(),
    totalAmount: order.totalAmount,
    currency: order.currency,
    customer: order.customer,
    items: enrichedItems.map((item, idx) => ({
      id: `${seq.formatted}-${idx + 1}`,
      ...item,
    })),
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod || null,
    shippingService: order.shippingService,
    shippingCost: order.shippingCost,
    trackingNumber: order.trackingNumber || null,
    carrier: order.carrier || null,
    buyerNote: order.buyerNote,
    weight: orderWeight,
  };

  // Use marketplaceKey as doc ID for idempotent creation (prevents duplicates on race condition)
  await db.collection(ORDERS_COLLECTION).doc(marketplaceKey).set(doc);

  // Pre-shipped orders: trigger stock decrement immediately (idempotent via stockDecrementedAt guard)
  if (initialStatus === 'shipped') {
    const { processShippedOrder } = require('./order-state-machine');
    processShippedOrder({ orderId: marketplaceKey, tenantId })
      .catch((err) => console.warn(`[ebay-intake] pre-shipped order stock-out failed for ${marketplaceKey}: ${err.message}`));
  }

  return true;
}

module.exports = {
  fetchEbayOrders,
  mapEbayOrder,
  syncEbayOrders,
  saveOrderIfNew,
  enrichOrderItemsWithWeight,
};
