'use strict';

/**
 * order-intake-ebay.js — Fetch orders directly from eBay Trading API.
 *
 * Uses GetOrders Trading API call to pull orders.
 * Replaces BaseLinker as order source for eBay.
 */

const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { callTradingApi } = require('../lib/ebay-trading-api');
const { getNextNumber } = require('./number-sequence');
const { reserveStock } = require('./stock-reservation');
const { syncStockWithRetry } = require('./stock-sync-dispatcher');
const { emitSyncEvent } = require('./sync-event-bus');

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
 * Map eBay Trading API Order to AvyCloud order format.
 */
function mapEbayOrder(ebayOrder) {
  const transactions = ebayOrder?.TransactionArray?.Transaction;
  const txArray = Array.isArray(transactions) ? transactions : transactions ? [transactions] : [];

  const items = txArray.map((tx) => ({
    name: tx?.Item?.Title || 'Unbekannter Artikel',
    sku: tx?.Item?.SKU || tx?.Variation?.SKU || null,
    quantity: parseInt(tx?.QuantityPurchased || '1', 10),
    priceBrutto: parseFloat(tx?.TransactionPrice?.['#text'] || tx?.TransactionPrice || '0'),
    currency: tx?.TransactionPrice?.['@_currencyID'] || 'EUR',
    itemId: tx?.Item?.ItemID || null,
    transactionId: tx?.TransactionID || null,
    ean: tx?.Variation?.VariationSpecifics?.NameValueList?.find?.((nv) => nv?.Name === 'EAN')?.Value?.[0] || null,
  }));

  const shippingAddr = ebayOrder?.ShippingAddress || {};
  const totalAmount = parseFloat(ebayOrder?.Total?.['#text'] || ebayOrder?.Total || '0');

  return {
    marketplaceOrderId: ebayOrder?.OrderID || null,
    source: 'ebay',
    marketplace: 'ebay',
    externalOrderId: ebayOrder?.OrderID || null,
    createdAt: ebayOrder?.CreatedTime || new Date().toISOString(),
    paidAt: ebayOrder?.PaidTime || null,
    totalAmount,
    currency: ebayOrder?.Total?.['@_currencyID'] || 'EUR',
    customer: {
      name: shippingAddr?.Name || ebayOrder?.BuyerUserID || 'Unbekannt',
      street: [shippingAddr?.Street1, shippingAddr?.Street2].filter(Boolean).join(', ') || null,
      city: shippingAddr?.CityName || null,
      zip: shippingAddr?.PostalCode || null,
      country: shippingAddr?.Country || null,
      phone: shippingAddr?.Phone || null,
      email: ebayOrder?.TransactionArray?.Transaction?.[0]?.Buyer?.Email || null,
    },
    items,
    paymentStatus: ebayOrder?.CheckoutStatus?.eBayPaymentStatus || ebayOrder?.PaymentStatus || null,
    shippingService: ebayOrder?.ShippingServiceSelected?.ShippingService || null,
    shippingCost: parseFloat(ebayOrder?.ShippingServiceSelected?.ShippingServiceCost?.['#text'] || '0'),
    buyerNote: ebayOrder?.BuyerCheckoutMessage || null,
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
  const now = new Date();
  const from = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

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
      } else {
        totalSkipped++;
      }
    }

    page++;
    if (page > result.totalPages) break;
  } while (page <= 50); // Safety limit

  // Reserve stock for newly imported orders
  for (const order of newOrders) {
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
  }

  // Push updated availability to all marketplaces
  if (newOrderSkus.size > 0) {
    try {
      const db = getDb();
      const skuArray = Array.from(newOrderSkus);
      for (let i = 0; i < skuArray.length; i += 10) {
        const chunk = skuArray.slice(i, i + 10);
        const snap = await db.collection('products_v2')
          .where('details.identifiers.sku', 'in', chunk)
          .get();
        for (const doc of snap.docs) {
          const product = { id: doc.id, ...doc.data() };
          syncStockWithRetry({ tenantId, product, reason: 'ebay-order-intake' })
            .catch((err) => console.warn(`[ebay-intake] stock sync failed for ${doc.id}: ${err.message}`));
        }
      }
      console.log(`[ebay-intake] triggered stock sync for ${newOrderSkus.size} SKUs from ${totalSynced} new orders`);
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
    // Legacy compatibility fields
    status: 'new',
    statusLabel: 'Neue Bestellung',
    createdAt: order.createdAt,
    paidAt: order.paidAt || null,
    updatedAt: new Date().toISOString(),
    totalAmount: order.totalAmount,
    currency: order.currency,
    customer: order.customer,
    items: order.items.map((item, idx) => ({
      id: `${seq.formatted}-${idx + 1}`,
      ...item,
    })),
    paymentStatus: order.paymentStatus,
    shippingService: order.shippingService,
    shippingCost: order.shippingCost,
    buyerNote: order.buyerNote,
  };

  await db.collection(ORDERS_COLLECTION).add(doc);
  return true;
}

module.exports = {
  fetchEbayOrders,
  mapEbayOrder,
  syncEbayOrders,
  saveOrderIfNew,
};
