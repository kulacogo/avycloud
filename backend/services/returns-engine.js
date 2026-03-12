'use strict';

/**
 * returns-engine.js — Returns Management Engine.
 *
 * Handles marketplace return intake (eBay + Kaufland), workflow state machine,
 * reason categorization, and refund communication.
 */

const { FieldValue } = require('@google-cloud/firestore');
const { firestore } = require('../lib/firestore');

const RETURNS_COLLECTION = 'returns';
const ORDERS_COLLECTION = 'orders';
const RETURN_EVENTS_COLLECTION = 'return_events';

function getDb() {
  return firestore;
}

// ─── Return Status Flow ──────────────────────────────────────

const RETURN_STATUSES = [
  'eingegangen',    // Return received/created
  'in_pruefung',    // Under review / inspection
  'erstattet',      // Refunded
  'teilweise_erstattet', // Partially refunded
  'abgelehnt',      // Rejected
  'abgeschlossen',  // Closed / finalized
];

const VALID_TRANSITIONS = {
  eingegangen:         ['in_pruefung', 'erstattet', 'abgelehnt'],
  in_pruefung:         ['erstattet', 'teilweise_erstattet', 'abgelehnt'],
  erstattet:           ['abgeschlossen'],
  teilweise_erstattet: ['abgeschlossen'],
  abgelehnt:           ['abgeschlossen', 'in_pruefung'], // Can re-open
  abgeschlossen:       [], // Terminal
};

// ─── Return Reason Categories ────────────────────────────────

const RETURN_REASONS = {
  defekt:              { label: 'Defekt / Beschädigt', refundDefault: 'full' },
  falsche_lieferung:   { label: 'Falsche Lieferung', refundDefault: 'full' },
  nicht_wie_beschrieben: { label: 'Nicht wie beschrieben', refundDefault: 'full' },
  zu_spaet:            { label: 'Zu spät geliefert', refundDefault: 'full' },
  meinungsaenderung:   { label: 'Meinungsänderung', refundDefault: 'full' },
  doppelbestellung:    { label: 'Doppelbestellung', refundDefault: 'full' },
  sonstiges:           { label: 'Sonstiges', refundDefault: 'partial' },
};

/**
 * eBay return reason → internal category mapping.
 */
const EBAY_REASON_MAP = {
  ARRIVED_DAMAGED:       'defekt',
  WRONG_ITEM_SENT:       'falsche_lieferung',
  NOT_AS_DESCRIBED:      'nicht_wie_beschrieben',
  LATE_DELIVERY:         'zu_spaet',
  BUYERS_REMORSE:        'meinungsaenderung',
  DUPLICATE_PURCHASE:    'doppelbestellung',
  OTHER:                 'sonstiges',
  DEFECTIVE:             'defekt',
  ITEM_BROKEN:           'defekt',
};

/**
 * Kaufland return reason → internal category mapping.
 */
const KAUFLAND_REASON_MAP = {
  // Uppercase (legacy/safety)
  WRONG_PRODUCT_DELIVERED: 'falsche_lieferung',
  DEFECTIVE:               'defekt',
  ITEM_NOT_AS_DESCRIBED:   'nicht_wie_beschrieben',
  NO_LONGER_NEEDED:        'meinungsaenderung',
  TOO_LATE:                'zu_spaet',
  DUPLICATE_ORDER:         'doppelbestellung',
  OTHER:                   'sonstiges',
  // Lowercase (actual Kaufland API values)
  wrong_product_delivered:  'falsche_lieferung',
  defective:               'defekt',
  item_not_as_described:    'nicht_wie_beschrieben',
  no_longer_needed:         'meinungsaenderung',
  too_late:                 'zu_spaet',
  duplicate_order:          'doppelbestellung',
  wrong_size:               'nicht_wie_beschrieben',
  too_big:                  'nicht_wie_beschrieben',
  too_small:                'nicht_wie_beschrieben',
  does_not_fit:             'nicht_wie_beschrieben',
  not_as_expected:          'nicht_wie_beschrieben',
  arrived_too_late:         'zu_spaet',
  damaged_in_transit:       'defekt',
  other:                    'sonstiges',
};

// ─── Return Workflow ─────────────────────────────────────────

/**
 * Transition a return to a new status with validation.
 *
 * @param {{
 *   returnId: string,
 *   toStatus: string,
 *   actor?: { uid: string, email: string },
 *   note?: string,
 *   itemCondition?: 'a_ware' | 'b_ware' | 'c_ware',
 *   refundAmount?: number,
 *   refundType?: 'full' | 'partial' | 'none',
 * }} opts
 * @returns {Promise<{ id: string, status: string }>}
 */
async function transitionReturn({
  returnId,
  toStatus,
  actor = { uid: 'system', email: 'api' },
  note = '',
  itemCondition,
  refundAmount,
  refundType,
}) {
  if (!returnId) throw new Error('returnId required');
  if (!RETURN_STATUSES.includes(toStatus)) {
    throw new Error(`Ungültiger Status: ${toStatus}`);
  }

  const db = getDb();
  const ref = db.collection(RETURNS_COLLECTION).doc(returnId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Retoure nicht gefunden');

  const current = snap.data();
  const fromStatus = current.status || 'eingegangen';

  const allowed = VALID_TRANSITIONS[fromStatus] || [];
  if (!allowed.includes(toStatus)) {
    throw new Error(`Übergang ${fromStatus} → ${toStatus} nicht erlaubt`);
  }

  const update = {
    status: toStatus,
    updatedAt: new Date().toISOString(),
  };

  if (itemCondition) update.itemCondition = itemCondition;
  if (refundAmount !== undefined) update.refundAmount = refundAmount;
  if (refundType) update.refundType = refundType;

  // Auto-set restock flag for A/B-ware
  if (itemCondition === 'a_ware' || itemCondition === 'b_ware') {
    update.restock = true;
  }
  if (itemCondition === 'c_ware') {
    update.restock = false;
  }

  await ref.set(update, { merge: true });

  // Log event
  await db.collection(RETURN_EVENTS_COLLECTION).add({
    returnId,
    fromStatus,
    toStatus,
    actor,
    note,
    itemCondition: itemCondition || null,
    refundAmount: refundAmount || null,
    timestamp: new Date().toISOString(),
  });

  return { id: returnId, status: toStatus };
}

/**
 * Process return: inspect item, decide refund, and optionally restock.
 *
 * @param {{
 *   returnId: string,
 *   tenantId?: string,
 *   itemCondition: 'a_ware' | 'b_ware' | 'c_ware',
 *   refundType: 'full' | 'partial' | 'none',
 *   refundAmount?: number,
 *   note?: string,
 *   actor?: object,
 * }} opts
 * @returns {Promise<{ id: string, status: string, restock: boolean }>}
 */
async function processReturn({
  returnId,
  tenantId = 'default',
  itemCondition,
  refundType,
  refundAmount,
  note = '',
  actor = { uid: 'system', email: 'api' },
}) {
  const db = getDb();
  const snap = await db.collection(RETURNS_COLLECTION).doc(returnId).get();
  if (!snap.exists) throw new Error('Retoure nicht gefunden');
  const ret = snap.data();

  // Determine target status based on refund decision
  let toStatus;
  if (refundType === 'none') {
    toStatus = 'abgelehnt';
  } else if (refundType === 'partial') {
    toStatus = 'teilweise_erstattet';
  } else {
    toStatus = 'erstattet';
  }

  // If item not yet in review, transition there first
  if (ret.status === 'eingegangen') {
    await transitionReturn({
      returnId, toStatus: 'in_pruefung', actor, note: 'Warenprüfung gestartet',
    });
  }

  // Calculate refund amount if not provided
  let finalAmount = refundAmount;
  if (finalAmount === undefined) {
    if (refundType === 'full') {
      finalAmount = ret.refundAmount || ret.orderAmount || 0;
    } else if (refundType === 'partial') {
      finalAmount = Math.round((ret.orderAmount || 0) * 0.5 * 100) / 100; // Default 50%
    } else {
      finalAmount = 0;
    }
  }

  // Transition to final status
  const result = await transitionReturn({
    returnId, toStatus, actor, note,
    itemCondition, refundAmount: finalAmount, refundType,
  });

  // Restock if A/B ware
  const shouldRestock = itemCondition === 'a_ware' || itemCondition === 'b_ware';
  if (shouldRestock && ret.orderId) {
    try {
      await restockItem({ returnId, orderId: ret.orderId, itemCondition, tenantId });
    } catch (err) {
      console.error(`[returns-engine] Restock failed for return ${returnId}: ${err.message}`);
    }
  }

  return { id: returnId, status: toStatus, restock: shouldRestock };
}

/**
 * Restock returned item back to inventory.
 *
 * @param {{ returnId: string, orderId: string, itemCondition: string, tenantId?: string }} opts
 */
async function restockItem({ returnId, orderId, itemCondition, tenantId = 'default' }) {
  const db = getDb();

  // Load original order to get product info
  const orderSnap = await db.collection(ORDERS_COLLECTION).doc(orderId).get();
  if (!orderSnap.exists) return;
  const order = orderSnap.data();

  const returnSnap = await db.collection(RETURNS_COLLECTION).doc(returnId).get();
  const ret = returnSnap.exists ? returnSnap.data() : {};

  // Find the returned product in order items
  const items = order.items || [];
  const returnedItem = ret.product
    ? items.find((i) => i.sku === ret.product?.sku || i.name === ret.product?.name)
    : items[0];

  if (!returnedItem) return;

  // Log warehouse movement for restock
  await db.collection('warehouse_movements').add({
    tenantId,
    type: 'restock_return',
    productSku: returnedItem.sku || null,
    productName: returnedItem.name || null,
    quantity: returnedItem.quantity || 1,
    condition: itemCondition,
    returnId,
    orderId,
    note: `Wiedereinlagerung aus Retoure (${itemCondition === 'a_ware' ? 'A-Ware' : 'B-Ware reduziert'})`,
    createdAt: new Date().toISOString(),
  });
}

// ─── Marketplace Return Intake ───────────────────────────────

/**
 * Sync returns from eBay via Post-Order REST API.
 * Uses GET /post-order/v2/return/search (JSON, OAuth bearer token).
 *
 * @param {{ tenantId?: string, lookbackDays?: number }} opts
 * @returns {Promise<{ synced: number, skipped: number, errors: number }>}
 */
async function syncEbayReturns({ tenantId = 'default', lookbackDays = 30 } = {}) {
  const { getValidEbayAccessToken } = require('../lib/ebay-oauth');
  const db = getDb();

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const { accessToken } = await getValidEbayAccessToken();
    const fromDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

    // Use eBay Sell Fulfillment API to find orders with refunds.
    // The Post-Order API is unstable (401 auth issues). The Fulfillment API
    // reliably returns refund data on line items.
    let allOrders = [];
    let offset = 0;
    const limit = 200;

    while (true) {
      const url = `https://api.ebay.com/sell/fulfillment/v1/order?limit=${limit}&offset=${offset}&filter=creationdate:[${encodeURIComponent(fromDate)}..]`;
      const res = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'X-EBAY-C-MARKETPLACE-ID': 'EBAY_DE',
          'Accept': 'application/json',
        },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`eBay Fulfillment API ${res.status}: ${body.slice(0, 500)}`);
      }

      const json = await res.json();
      const orders = json.orders || [];
      allOrders = allOrders.concat(orders);

      if (allOrders.length >= (json.total || 0) || orders.length < limit) break;
      offset += limit;
    }

    // Extract orders that have refunds or cancellations
    for (const order of allOrders) {
      try {
        const isCanceled = order.cancelStatus?.cancelState &&
          order.cancelStatus.cancelState !== 'NONE_REQUESTED';
        const refundedItems = (order.lineItems || []).filter(
          (li) => li.refunds && li.refunds.length > 0
        );

        if (!isCanceled && refundedItems.length === 0) continue;

        const marketplaceReturnId = order.orderId || '';
        if (!marketplaceReturnId) continue;

        // Deduplicate
        const existing = await db.collection(RETURNS_COLLECTION)
          .where('marketplaceReturnId', '==', String(marketplaceReturnId))
          .where('marketplace', '==', 'ebay')
          .limit(1)
          .get();

        if (!existing.empty) {
          // Update marketplace status + fix missing data on re-sync
          const existingDoc = existing.docs[0];
          const existingData = existingDoc.data();
          const newMpStatus = isCanceled ? 'CANCELED' : 'REFUNDED';
          const updates = {};
          if (existingData.marketplaceStatus !== newMpStatus) {
            updates.marketplaceStatus = newMpStatus;
          }
          // Fix customer name if it was stored as eBay username
          const shipTo = order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
          const realName = shipTo?.fullName || shipTo?.contactAddress?.fullName || null;
          if (realName && (!existingData.customer?.name || existingData.customer.name === order.buyer?.username)) {
            updates.customer = { name: realName, email: shipTo?.email || existingData.customer?.email || null };
          }
          // Fix missing product name
          const pNames = (order.lineItems || []).map((li) => li.title).filter(Boolean);
          if (pNames[0] && (!existingData.product?.name)) {
            updates.product = { ...existingData.product, name: pNames[0] };
          }
          // Fix refundAmount if 0
          if ((!existingData.refundAmount || existingData.refundAmount === 0) && totalRefund > 0) {
            updates.refundAmount = totalRefund;
          }
          if (Object.keys(updates).length > 0) {
            updates.syncedAt = new Date().toISOString();
            await existingDoc.ref.update(updates);
          }
          skipped++;
          continue;
        }

        // Determine reason from cancel or refund context
        const cancelReason = order.cancelStatus?.cancelReason || '';
        let reason = 'meinungsaenderung'; // sensible default for returns
        if (isCanceled) {
          if (cancelReason === 'BUYER_ASKED_CANCEL' || cancelReason === 'BUYER_CANCEL') {
            reason = 'meinungsaenderung';
          } else if (cancelReason === 'OUT_OF_STOCK_OR_CANNOT_FULFILL') {
            reason = 'sonstiges';
          } else {
            reason = EBAY_REASON_MAP[cancelReason] || 'meinungsaenderung';
          }
        } else if (refundedItems.length > 0) {
          // Check if any refund has a reason hint
          const refundReason = refundedItems[0]?.refunds?.[0]?.reasonType || '';
          reason = EBAY_REASON_MAP[refundReason] || 'meinungsaenderung';
        }

        // Sum refund amounts
        let totalRefund = 0;
        for (const li of refundedItems) {
          for (const ref of (li.refunds || [])) {
            totalRefund += parseFloat(ref.amount?.value || '0') || 0;
          }
        }

        const productNames = (order.lineItems || [])
          .map((li) => li.title)
          .filter(Boolean);

        // Extract real customer name from shipping address (not username)
        const shipTo = order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
        const buyerFullName = shipTo?.fullName
          || (shipTo?.contactAddress?.fullName)
          || order.buyer?.username
          || null;
        const buyerEmail = shipTo?.email || order.buyer?.email || null;

        const returnDoc = {
          tenantId,
          marketplace: 'ebay',
          marketplaceReturnId: String(marketplaceReturnId),
          marketplaceOrderId: order.orderId || null,
          orderId: null,
          customer: {
            name: buyerFullName,
            email: buyerEmail,
          },
          product: {
            name: productNames[0] || null,
            sku: (order.lineItems || [])[0]?.sku || null,
            quantity: refundedItems.length || 1,
          },
          reason,
          reasonRaw: ebayReason,
          reasonText: order.cancelStatus?.cancelReason || null,
          refundAmount: totalRefund,
          currency: 'EUR',
          status: 'eingegangen',
          marketplaceStatus: isCanceled ? 'CANCELED' : 'REFUNDED',
          createdAt: order.creationDate || new Date().toISOString(),
          syncedAt: new Date().toISOString(),
        };

        // Link to internal order
        if (returnDoc.marketplaceOrderId) {
          const orderSnap = await db.collection(ORDERS_COLLECTION)
            .where('marketplaceOrderId', '==', returnDoc.marketplaceOrderId)
            .limit(1)
            .get();
          if (!orderSnap.empty) {
            returnDoc.orderId = orderSnap.docs[0].id;
            returnDoc.orderAmount = orderSnap.docs[0].data().totalAmount || 0;
          }
        }

        await db.collection(RETURNS_COLLECTION).add(returnDoc);
        synced++;
      } catch (err) {
        console.error(`[returns-engine] eBay return parse error: ${err.message}`);
        errors++;
      }
    }
  } catch (err) {
    console.error(`[returns-engine] eBay returns sync failed: ${err.message}`);
    errors++;
    console.log(`[returns-engine] eBay sync: ${synced} synced, ${skipped} skipped, ${errors} errors`);
    return { synced, skipped, errors, errorMessage: err.message };
  }

  console.log(`[returns-engine] eBay sync: ${synced} synced, ${skipped} skipped, ${errors} errors`);
  return { synced, skipped, errors };
}

/**
 * Sync returns from Kaufland via GET /returns.
 *
 * @param {{ tenantId?: string, lookbackDays?: number }} opts
 * @returns {Promise<{ synced: number, skipped: number, errors: number }>}
 */
async function syncKauflandReturns({ tenantId = 'default', lookbackDays = 30 } = {}) {
  const { kauflandRequest } = require('../lib/kaufland-api');
  const db = getDb();

  let synced = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const fromDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

    // kauflandRequest returns { status, data: <parsed JSON>, headers }.
    // The Kaufland API response body is { data: [...], pagination: {...} }.
    const result = await kauflandRequest('GET', '/returns', {
      query: { limit: 100 },
    });

    const responseBody = result?.data || {};
    const returns = Array.isArray(responseBody?.data) ? responseBody.data : [];

    for (const kr of returns) {
      try {
        const marketplaceReturnId = String(kr.id_return || kr.id || '');
        if (!marketplaceReturnId) continue;

        // Fetch detail with return_units + buyer to get order linkage & reason
        let returnDetail = null;
        try {
          const detailRes = await kauflandRequest('GET', `/returns/${marketplaceReturnId}`, {
            query: { 'embedded[]': 'return_units' },
          });
          returnDetail = detailRes?.data?.data || null;
        } catch {
          // Non-critical — fall back to list data
        }

        const returnUnits = returnDetail?.return_units || [];
        const firstUnit = returnUnits[0] || {};
        const orderUnitId = firstUnit.id_order_unit ? String(firstUnit.id_order_unit) : null;
        const unitReason = firstUnit.reason || kr.reason || 'OTHER';

        // Fetch order-unit detail for product, buyer, and order linkage
        let orderUnitDetail = null;
        if (orderUnitId) {
          try {
            const ouRes = await kauflandRequest('GET', `/order-units/${orderUnitId}`);
            orderUnitDetail = ouRes?.data?.data || null;
          } catch {
            // Non-critical
          }
        }

        // Deduplicate
        const existing = await db.collection(RETURNS_COLLECTION)
          .where('marketplaceReturnId', '==', marketplaceReturnId)
          .where('marketplace', '==', 'kaufland')
          .limit(1)
          .get();

        if (!existing.empty) {
          // Update marketplace status if changed
          const existingDoc = existing.docs[0];
          const existingData = existingDoc.data();
          const newStatus = kr.status || null;
          const updates = {};
          if (newStatus && existingData.marketplaceStatus !== newStatus) {
            updates.marketplaceStatus = newStatus;
          }
          if (kr.tracking_code && !existingData.trackingCode) {
            updates.trackingCode = kr.tracking_code;
          }
          if (orderUnitId && !existingData.orderUnitId) {
            updates.orderUnitId = orderUnitId;
          }
          if (unitReason && unitReason !== 'OTHER' && unitReason.toLowerCase() !== 'other' && (!existingData.reasonRaw || existingData.reasonRaw === 'OTHER' || existingData.reason === 'sonstiges')) {
            updates.reasonRaw = unitReason;
            updates.reason = KAUFLAND_REASON_MAP[unitReason] || KAUFLAND_REASON_MAP[unitReason.toLowerCase()] || existingData.reason;
          }
          // Update refundAmount if still 0 and we have price info
          if ((!existingData.refundAmount || existingData.refundAmount === 0) && orderUnitDetail?.price) {
            updates.refundAmount = orderUnitDetail.price / 100;
          }
          // Link to order if not yet linked
          if (!existingData.orderId && orderUnitId) {
            const orderSnap = await db.collection(ORDERS_COLLECTION)
              .where('marketplace', '==', 'kaufland')
              .limit(200)
              .get();
            // Search order items for matching order_unit_id
            for (const oDoc of orderSnap.docs) {
              const oData = oDoc.data();
              const items = oData.products || oData.items || [];
              const match = items.some((item) => String(item.order_unit_id || item.id_order_unit || '') === orderUnitId);
              if (match) {
                updates.orderId = oDoc.id;
                updates.orderAmount = oData.totalAmount || 0;
                updates.product = {
                  name: items.find((i) => String(i.order_unit_id || i.id_order_unit || '') === orderUnitId)?.name || existingData.product?.name || null,
                  sku: items.find((i) => String(i.order_unit_id || i.id_order_unit || '') === orderUnitId)?.sku || existingData.product?.sku || null,
                  quantity: 1,
                };
                break;
              }
            }
          }
          if (Object.keys(updates).length > 0) {
            updates.syncedAt = new Date().toISOString();
            await existingDoc.ref.update(updates);
          }
          skipped++;
          continue;
        }

        const reason = KAUFLAND_REASON_MAP[unitReason] || KAUFLAND_REASON_MAP[unitReason.toLowerCase()] || 'sonstiges';

        // Build customer & product from order-unit detail
        const ouBuyer = orderUnitDetail?.buyer || {};
        const ouProduct = orderUnitDetail?.product || {};
        const ouShipping = orderUnitDetail?.shipping_address || orderUnitDetail?.billing_address || {};
        const buyerName = ouShipping.first_name && ouShipping.last_name
          ? `${ouShipping.first_name} ${ouShipping.last_name}`
          : (kr.buyer_name || kr.buyer?.name || null);

        const returnDoc = {
          tenantId,
          marketplace: 'kaufland',
          marketplaceReturnId,
          marketplaceOrderId: orderUnitDetail?.id_order || orderUnitId,
          orderUnitId,
          orderId: null,
          customer: {
            name: buyerName,
            email: ouBuyer.email || kr.buyer_email || null,
          },
          product: {
            name: ouProduct.title || kr.product_title || kr.title || null,
            sku: orderUnitDetail?.id_offer || (kr.id_offer ? String(kr.id_offer) : null),
            quantity: kr.quantity || 1,
            ean: ouProduct.eans?.[0] || null,
            price: orderUnitDetail?.price ? (orderUnitDetail.price / 100) : null,
          },
          reason,
          reasonRaw: unitReason,
          reasonText: firstUnit.note || kr.reason_comment || null,
          refundAmount: parseFloat(kr.refund_amount || '0')
            || (orderUnitDetail?.price ? (orderUnitDetail.price / 100) : 0)
            || 0,
          currency: 'EUR',
          status: 'eingegangen',
          marketplaceStatus: kr.status || null,
          trackingCode: kr.tracking_code || null,
          trackingProvider: kr.tracking_provider || null,
          createdAt: kr.ts_created_iso || kr.ts_created || new Date().toISOString(),
          syncedAt: new Date().toISOString(),
        };

        // Link to order via Kaufland order ID (e.g. "MXB5KD5")
        if (returnDoc.marketplaceOrderId) {
          const orderSnap = await db.collection(ORDERS_COLLECTION)
            .where('marketplaceOrderId', '==', returnDoc.marketplaceOrderId)
            .limit(1)
            .get();
          if (!orderSnap.empty) {
            returnDoc.orderId = orderSnap.docs[0].id;
            returnDoc.orderAmount = orderSnap.docs[0].data().totalAmount || 0;
          }
        }

        await db.collection(RETURNS_COLLECTION).add(returnDoc);
        synced++;
      } catch (err) {
        console.error(`[returns-engine] Kaufland return parse error: ${err.message}`);
        errors++;
      }
    }
  } catch (err) {
    console.error(`[returns-engine] Kaufland returns sync failed: ${err.message}`);
    errors++;
    console.log(`[returns-engine] Kaufland sync: ${synced} synced, ${skipped} skipped, ${errors} errors`);
    return { synced, skipped, errors, errorMessage: err.message };
  }

  console.log(`[returns-engine] Kaufland sync: ${synced} synced, ${skipped} skipped, ${errors} errors`);
  return { synced, skipped, errors };
}

/**
 * Sync returns from all configured marketplaces.
 *
 * @param {{ tenantId?: string, lookbackDays?: number }} opts
 * @returns {Promise<{ ebay: object, kaufland: object }>}
 */
async function syncAllReturns({ tenantId = 'default', lookbackDays = 30 } = {}) {
  const results = {};

  try {
    results.ebay = await syncEbayReturns({ tenantId, lookbackDays });
  } catch (err) {
    results.ebay = { synced: 0, skipped: 0, errors: 1, error: err.message };
  }

  try {
    results.kaufland = await syncKauflandReturns({ tenantId, lookbackDays });
  } catch (err) {
    results.kaufland = { synced: 0, skipped: 0, errors: 1, error: err.message };
  }

  return results;
}

// ─── Marketplace Refund APIs ─────────────────────────────────

/**
 * Issue a refund via the marketplace API.
 *
 * @param {{ returnId: string, tenantId?: string, actor?: object }} opts
 * @returns {Promise<{ ok: boolean, marketplace?: string, error?: string }>}
 */
async function issueMarketplaceRefund({ returnId, tenantId = 'default', actor }) {
  const db = getDb();
  const snap = await db.collection(RETURNS_COLLECTION).doc(returnId).get();
  if (!snap.exists) throw new Error('Retoure nicht gefunden');

  const ret = snap.data();
  const marketplace = (ret.marketplace || '').toLowerCase();

  if (marketplace === 'ebay') {
    return issueEbayRefund({ ret, returnId });
  }
  if (marketplace === 'kaufland') {
    return issueKauflandRefund({ ret, returnId });
  }

  return { ok: true, marketplace, skipped: 'No marketplace refund needed' };
}

/**
 * Issue eBay refund via Post-Order REST API.
 * POST /post-order/v2/return/{returnId}/issue_refund
 */
async function issueEbayRefund({ ret, returnId }) {
  try {
    const { getValidEbayAccessToken } = require('../lib/ebay-oauth');

    const marketplaceReturnId = ret.marketplaceReturnId;
    if (!marketplaceReturnId) return { ok: false, marketplace: 'ebay', error: 'No eBay return ID' };

    const { accessToken, apiBaseUrl } = await getValidEbayAccessToken();
    const amount = ret.refundAmount || 0;
    const refundType = ret.refundType === 'partial' ? 'OTHER' : 'FULL_REFUND';

    const refundUrl = `${apiBaseUrl}/post-order/v2/return/${encodeURIComponent(marketplaceReturnId)}/issue_refund`;

    const res = await fetch(refundUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_DE',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        comments: { content: `Refund issued via AvyCloud` },
        refundDetail: {
          itemizedRefundDetail: [{
            refundAmount: { value: amount.toFixed(2), currency: ret.currency || 'EUR' },
            refundFeeType: refundType,
          }],
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`eBay refund API ${res.status}: ${body.slice(0, 500)}`);
    }

    console.log(`[returns-engine] eBay refund for return ${marketplaceReturnId}: success`);

    // Update return with refund status
    await getDb().collection(RETURNS_COLLECTION).doc(returnId).set({
      marketplaceRefundStatus: 'issued',
      marketplaceRefundAt: new Date().toISOString(),
    }, { merge: true });

    return { ok: true, marketplace: 'ebay' };
  } catch (err) {
    console.error(`[returns-engine] eBay refund failed: ${err.message}`);
    return { ok: false, marketplace: 'ebay', error: err.message };
  }
}

/**
 * Issue Kaufland refund via API.
 */
async function issueKauflandRefund({ ret, returnId }) {
  try {
    const { kauflandRequest } = require('../lib/kaufland-api');

    const marketplaceReturnId = ret.marketplaceReturnId;
    if (!marketplaceReturnId) return { ok: false, marketplace: 'kaufland', error: 'No Kaufland return ID' };

    await kauflandRequest('PATCH', `/returns/${marketplaceReturnId}/accept`, {
      body: {
        refund_amount: ret.refundAmount || 0,
      },
    });

    console.log(`[returns-engine] Kaufland refund for return ${marketplaceReturnId}`);

    await getDb().collection(RETURNS_COLLECTION).doc(returnId).set({
      marketplaceRefundStatus: 'issued',
      marketplaceRefundAt: new Date().toISOString(),
    }, { merge: true });

    return { ok: true, marketplace: 'kaufland' };
  } catch (err) {
    console.error(`[returns-engine] Kaufland refund failed: ${err.message}`);
    return { ok: false, marketplace: 'kaufland', error: err.message };
  }
}

// ─── Helpers ─────────────────────────────────────────────────

/**
 * Extract array from XML-parsed object (handles single item vs array).
 */
function extractArray(obj, key) {
  if (!obj || !obj[key]) return [];
  return Array.isArray(obj[key]) ? obj[key] : [obj[key]];
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = {
  // Workflow
  transitionReturn,
  processReturn,
  restockItem,

  // Marketplace Intake
  syncEbayReturns,
  syncKauflandReturns,
  syncAllReturns,

  // Refunds
  issueMarketplaceRefund,

  // Constants
  RETURN_STATUSES,
  VALID_TRANSITIONS,
  RETURN_REASONS,
  EBAY_REASON_MAP,
  KAUFLAND_REASON_MAP,
};
