'use strict';

/**
 * marketplace-tracking.js — Push tracking info back to eBay & Kaufland.
 *
 * After a shipping label is created, this service notifies the marketplace
 * that the order has shipped, providing tracking number and carrier.
 */

const { Firestore } = require('@google-cloud/firestore');
const { collectError } = require('../lib/error-collector');

const ORDERS_COLLECTION = 'orders';

let _db;
function getDb() {
  if (!_db) _db = new Firestore();
  return _db;
}

/**
 * Carrier code mapping for eBay CompleteSale.
 * eBay requires specific carrier names.
 */
const EBAY_CARRIER_MAP = {
  dhl: 'DHL',
  'dhl-de': 'DHL',
  dpd: 'DPD',
  'dpd-de': 'DPD',
  hermes: 'Hermes',
  gls: 'GLS',
  ups: 'UPS',
  dhl_express: 'DHL Express',
};

/**
 * Carrier code mapping for Kaufland.
 * Values MUST match Kaufland's accepted carrier_code list exactly (Title Case, spaces).
 * See https://sellerapi.kaufland.com/?page=order-files#carrier-codes
 */
const KAUFLAND_CARRIER_MAP = {
  dhl: 'DHL',
  'dhl-de': 'DHL',
  dhlde: 'DHL',
  dhlde_v2: 'DHL',
  dhl_express: 'DHL',
  dhlexpress: 'DHL',
  dpd: 'DPD',
  'dpd-de': 'DPD',
  dpdde: 'DPD',
  hermes: 'Hermes',
  gls: 'GLS',
  ups: 'UPS',
  fedex: 'Fedex',
  tnt: 'TNT',
  deutsche_post: 'Deutsche Post',
  deutschepost: 'Deutsche Post',
  dhl_freight: 'DHL Freight',
  dhl_ecommerce: 'DHL Ecommerce',
};

/**
 * Normalize a carrier identifier to a Kaufland-accepted carrier_code.
 * Falls back to 'Other' when no clean match is found — Kaufland accepts
 * 'Other' as catch-all and never rejects on it.
 *
 * @param {string} carrier - Internal carrier identifier (e.g. "dhl", "DPD-DE")
 * @returns {string} A valid Kaufland carrier_code
 */
function normalizeKauflandCarrier(carrier) {
  if (!carrier) return 'Other';
  const key = String(carrier).trim().toLowerCase().replace(/\s+/g, '_');
  if (KAUFLAND_CARRIER_MAP[key]) return KAUFLAND_CARRIER_MAP[key];
  // Strip common prefixes/suffixes and retry (e.g. "dhl_de_v2" → "dhl")
  const stripped = key.replace(/_v\d+$/, '').replace(/_de$/, '');
  if (KAUFLAND_CARRIER_MAP[stripped]) return KAUFLAND_CARRIER_MAP[stripped];
  return 'Other';
}

/**
 * Push tracking info to the order's marketplace.
 *
 * @param {{
 *   orderId: string,
 *   trackingNumber: string,
 *   carrier: string,
 * }} opts
 * @returns {Promise<{ ok: boolean, marketplace?: string, error?: string }>}
 */
async function pushTrackingToMarketplace({ orderId, trackingNumber, carrier }) {
  if (!orderId) return { ok: false, error: 'orderId required' };
  if (!trackingNumber) return { ok: false, error: 'trackingNumber required' };

  const orderSnap = await getDb().collection(ORDERS_COLLECTION).doc(orderId).get();
  if (!orderSnap.exists) return { ok: false, error: 'Order not found' };

  const order = orderSnap.data();
  // Check marketplace, orderSource, then source
  const marketplace = (order.marketplace || order.orderSource || '').toLowerCase();

  let result;
  if (marketplace === 'ebay') {
    result = await pushTrackingToEbay({ order, trackingNumber, carrier });
  } else if (marketplace === 'kaufland') {
    result = await pushTrackingToKaufland({ order, trackingNumber, carrier, firestoreDocRef: orderSnap.ref });
  } else {
    result = { ok: true, marketplace, skipped: 'no marketplace push needed' };
  }

  // Track push status on the order document for retry/audit
  try {
    await orderSnap.ref.set({
      marketplacePush: {
        status: result.ok ? 'success' : 'failed',
        marketplace,
        lastAttempt: new Date().toISOString(),
        error: result.ok ? null : (result.error || 'unknown'),
        trackingNumber,
        carrier: carrier || null,
      },
    }, { merge: true });
  } catch (err) {
    console.warn(`[marketplace-tracking] Failed to save push status for ${orderId}: ${err.message}`);
  }

  // Schedule immediate retry on failure (5 min delay) instead of waiting for 24h batch
  if (!result.ok && marketplace) {
    const RETRY_DELAY_MS = 5 * 60 * 1000;
    setTimeout(() => {
      console.log(`[marketplace-tracking] Auto-retry push for ${orderId} after failure`);
      pushTrackingToMarketplace({ orderId, trackingNumber, carrier })
        .catch((err) => console.warn(`[marketplace-tracking] Auto-retry failed for ${orderId}: ${err.message}`));
    }, RETRY_DELAY_MS);
  }

  return result;
}

/**
 * Push tracking to eBay via CompleteSale (Trading API).
 *
 * @param {{ order: object, trackingNumber: string, carrier: string }} opts
 * @returns {Promise<{ ok: boolean, marketplace: string, error?: string }>}
 */
async function pushTrackingToEbay({ order, trackingNumber, carrier }) {
  try {
    const { callTradingApi, buildRequestRoot, getEbayTradingConfig } = require('../lib/ebay-trading-api');

    const ebayOrderId = order.marketplaceOrderId || order.externalOrderId;
    if (!ebayOrderId) return { ok: false, marketplace: 'ebay', error: 'No eBay order ID' };

    const ebayCarrier = EBAY_CARRIER_MAP[(carrier || '').toLowerCase()] || carrier || 'Other';

    // Build inner XML for CompleteSale
    const innerXml = `
  <OrderID>${escapeXml(ebayOrderId)}</OrderID>
  <Shipped>true</Shipped>
  <Shipment>
    <ShipmentTrackingDetails>
      <ShipmentTrackingNumber>${escapeXml(trackingNumber)}</ShipmentTrackingNumber>
      <ShippingCarrierUsed>${escapeXml(ebayCarrier)}</ShippingCarrierUsed>
    </ShipmentTrackingDetails>
  </Shipment>`;

    // Wrap in SOAP envelope with auth token
    const cfg = await getEbayTradingConfig();
    const fullXml = buildRequestRoot('CompleteSale', innerXml, cfg.userToken, cfg.compatibilityLevel);

    const result = await callTradingApi('CompleteSale', fullXml);
    console.log(`[marketplace-tracking] eBay CompleteSale for order ${ebayOrderId}: Ack=${result.ack}`);

    return { ok: true, marketplace: 'ebay' };
  } catch (err) {
    console.error(`[marketplace-tracking] eBay push failed: ${err.message}`);
    collectError({ type: 'api_error', severity: 'warning', channel: 'ebay', message: `Tracking-Push eBay fehlgeschlagen: ${err.message}`, entityType: 'order', entityId: order.marketplaceOrderId || order.externalOrderId, source: 'marketplace-tracking' });
    return { ok: false, marketplace: 'ebay', error: err.message };
  }
}

/**
 * Push tracking to Kaufland via PATCH /units/{id}/shipment.
 *
 * Kaufland requires per-unit shipment confirmation.
 *
 * @param {{ order: object, trackingNumber: string, carrier: string }} opts
 * @returns {Promise<{ ok: boolean, marketplace: string, error?: string }>}
 */
async function pushTrackingToKaufland({ order, trackingNumber, carrier, firestoreDocRef }) {
  try {
    const { kauflandRequest } = require('../lib/kaufland-api');

    const klCarrier = normalizeKauflandCarrier(carrier);

    // Kaufland needs per-unit shipment confirmation
    const items = order.items || [];
    const unitIds = items.map((item) => item.unitId).filter(Boolean);
    let fetchedFromApi = false;

    if (unitIds.length === 0) {
      // Fallback: fetch unit IDs from Kaufland API
      const klOrderId = order.marketplaceOrderId || order.externalOrderId;
      if (!klOrderId) return { ok: false, marketplace: 'kaufland', error: 'No Kaufland order/unit IDs' };

      const orderRes = await kauflandRequest('GET', `/orders/${klOrderId}`);
      const orderData = orderRes?.data?.data || orderRes?.data || orderRes;
      const units = Array.isArray(orderData?.order_units) ? orderData.order_units : [];
      for (const unit of units) {
        if (unit.id_order_unit) unitIds.push(unit.id_order_unit);
      }
      fetchedFromApi = unitIds.length > 0;

      // Backfill unitIds to Firestore so future retries don't need API call
      if (fetchedFromApi && firestoreDocRef) {
        try {
          const updatedItems = items.map((item, idx) => ({
            ...item,
            unitId: item.unitId || unitIds[idx] || null,
          }));
          await firestoreDocRef.update({ items: updatedItems });
          console.log(`[marketplace-tracking] Backfilled ${unitIds.length} Kaufland unitIds for order ${klOrderId}`);
        } catch (backfillErr) {
          console.warn(`[marketplace-tracking] unitId backfill failed: ${backfillErr.message}`);
        }
      }
    }

    if (unitIds.length === 0) {
      return { ok: false, marketplace: 'kaufland', error: 'No unit IDs found (API + local)' };
    }

    let successCount = 0;
    let lastError = null;

    for (const unitId of unitIds) {
      try {
        await kauflandRequest('PATCH', `/order-units/${unitId}/send`, {
          body: {
            tracking_numbers: trackingNumber,
            carrier_code: klCarrier,
          },
        });
        successCount++;
      } catch (err) {
        lastError = err.message;
        console.error(`[marketplace-tracking] Kaufland unit ${unitId} ship failed: ${err.message}`);
      }
    }

    if (successCount === 0 && unitIds.length > 0) {
      return { ok: false, marketplace: 'kaufland', error: lastError || 'All unit shipments failed' };
    }

    console.log(`[marketplace-tracking] Kaufland: ${successCount}/${unitIds.length} units shipped for order ${order.marketplaceOrderId}`);
    return { ok: true, marketplace: 'kaufland', unitsShipped: successCount };
  } catch (err) {
    console.error(`[marketplace-tracking] Kaufland push failed: ${err.message}`);
    return { ok: false, marketplace: 'kaufland', error: err.message };
  }
}

// ─── Ensure / Retry Push ────────────────────────────────────────────────────

/**
 * Ensure that marketplace tracking has been pushed for a shipped order.
 * If the previous push failed or was never attempted, retry now.
 *
 * Called from sync-event-bus as a safety net after status transitions.
 *
 * @param {{ orderId: string }} opts
 * @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string }>}
 */
async function ensureMarketplaceTrackingPushed({ orderId }) {
  if (!orderId) return { ok: false, error: 'orderId required' };

  const orderSnap = await getDb().collection(ORDERS_COLLECTION).doc(orderId).get();
  if (!orderSnap.exists) return { ok: false, error: 'Order not found' };

  const order = orderSnap.data();

  // Only relevant for shipped orders
  const status = order.omsStatus || order.status || '';
  if (!['shipped', 'delivered', 'completed'].includes(status)) {
    return { ok: true, skipped: true };
  }

  // Already successfully pushed?
  if (order.marketplacePush?.status === 'success') {
    return { ok: true, skipped: true };
  }

  // Need tracking number to push
  const trackingNumber = order.trackingNumber || order.tracking?.trackingNumber;
  if (!trackingNumber) {
    return { ok: false, error: 'No tracking number on order' };
  }

  const carrier = order.carrier || order.shippingService || order.tracking?.carrier || 'other';
  console.log(`[marketplace-tracking] Retry push for order ${orderId} (prev=${order.marketplacePush?.status || 'never'})`);

  return pushTrackingToMarketplace({ orderId, trackingNumber, carrier });
}

/**
 * Catch-up: Find all shipped orders where marketplace push failed or was never done, and retry.
 * Called periodically as a safety net.
 *
 * @param {{ tenantId?: string, maxAge?: number }} opts — maxAge in days (default: 7)
 * @returns {Promise<{ checked: number, retried: number, succeeded: number, failed: number }>}
 */
async function retryFailedMarketplacePushes({ tenantId = 'default', maxAge = 7 } = {}) {
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAge * 24 * 60 * 60 * 1000).toISOString();

  let checked = 0;
  let retried = 0;
  let succeeded = 0;
  let failed = 0;

  // 1) Retry shipped orders without successful tracking push
  const shippedSnap = await db.collection(ORDERS_COLLECTION)
    .where('omsStatus', '==', 'shipped')
    .where('updatedAt', '>=', cutoff)
    .limit(50)
    .get();

  for (const doc of shippedSnap.docs) {
    checked++;
    const order = doc.data();
    const marketplace = (order.marketplace || order.orderSource || '').toLowerCase();

    if (!['ebay', 'kaufland'].includes(marketplace)) continue;
    if (order.marketplacePush?.status === 'success') continue;

    const trackingNumber = order.trackingNumber || order.tracking?.trackingNumber;
    if (!trackingNumber) continue;

    retried++;
    const carrier = order.carrier || order.shippingService || order.tracking?.carrier || 'other';

    try {
      const result = await pushTrackingToMarketplace({
        orderId: doc.id,
        trackingNumber,
        carrier,
      });
      if (result.ok) {
        succeeded++;
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      console.error(`[marketplace-tracking] Retry tracking push failed for ${doc.id}: ${err.message}`);
    }
  }

  // 2) Retry cancelled orders without successful cancellation push
  const cancelledSnap = await db.collection(ORDERS_COLLECTION)
    .where('omsStatus', '==', 'cancelled')
    .where('updatedAt', '>=', cutoff)
    .limit(50)
    .get();

  for (const doc of cancelledSnap.docs) {
    checked++;
    const order = doc.data();
    const marketplace = (order.marketplace || order.orderSource || '').toLowerCase();

    if (!['ebay', 'kaufland'].includes(marketplace)) continue;
    if (order.marketplaceCancelPush?.status === 'success') continue;

    retried++;
    try {
      const result = await pushCancellationToMarketplace({
        orderId: doc.id,
        reason: order.cancelReason || 'other',
      });

      // Track cancellation push status on the order document
      await doc.ref.set({
        marketplaceCancelPush: {
          status: result.ok ? 'success' : 'failed',
          marketplace,
          lastAttempt: new Date().toISOString(),
          error: result.ok ? null : (result.error || 'unknown'),
        },
      }, { merge: true });

      if (result.ok) {
        succeeded++;
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      console.error(`[marketplace-tracking] Retry cancel push failed for ${doc.id}: ${err.message}`);
    }
  }

  if (retried > 0) {
    console.log(`[marketplace-tracking] Catch-up: checked=${checked} retried=${retried} succeeded=${succeeded} failed=${failed}`);
  }

  return { checked, retried, succeeded, failed };
}

// ─── Cancellation Push ──────────────────────────────────────────────────────

/**
 * Cancel reason mapping for Kaufland API.
 */
const KAUFLAND_CANCEL_REASONS = {
  out_of_stock: 'OUT_OF_STOCK',
  customer_requested: 'BUYER_CANCELLED',
  defective: 'DEFECTIVE_GOODS',
  wrong_address: 'CUSTOMER_DATA_INCORRECT',
  other: 'GENERAL_ADJUSTMENT',
};

/**
 * Push cancellation to the order's marketplace.
 *
 * @param {{
 *   orderId: string,
 *   reason?: string,
 *   note?: string,
 * }} opts
 * @returns {Promise<{ ok: boolean, marketplace?: string, error?: string }>}
 */
async function pushCancellationToMarketplace({ orderId, reason, note }) {
  if (!orderId) return { ok: false, error: 'orderId required' };

  const orderSnap = await getDb().collection(ORDERS_COLLECTION).doc(orderId).get();
  if (!orderSnap.exists) return { ok: false, error: 'Order not found' };

  const order = orderSnap.data();
  const marketplace = (order.marketplace || order.orderSource || '').toLowerCase();

  if (marketplace === 'ebay') {
    return cancelOrderOnEbay({ order, reason, note });
  }
  if (marketplace === 'kaufland') {
    return cancelOrderOnKaufland({ order, reason, note });
  }

  return { ok: true, marketplace, skipped: 'no marketplace cancel needed' };
}

/**
 * Cancel an eBay order via Trading API (CancelTransaction not available for
 * managed payments — use VoidFixedPriceItem to set qty to 0 as workaround,
 * or EndItem for single-listing orders).
 *
 * For eBay managed payments orders, seller-initiated cancellation is best done
 * by setting quantity to 0 to prevent further sales + marking as shipped with
 * a note. eBay's official Post-Order cancellation API requires buyer consent.
 *
 * @param {{ order: object, reason?: string, note?: string }} opts
 */
async function cancelOrderOnEbay({ order, reason, note }) {
  try {
    const { reviseFixedPriceItem } = require('../lib/ebay-trading-api');

    const ebayOrderId = order.marketplaceOrderId || order.externalOrderId;
    if (!ebayOrderId) return { ok: false, marketplace: 'ebay', error: 'No eBay order ID' };

    // Set quantity to 0 on linked eBay listings to prevent further sales
    const items = order.items || [];
    let revised = 0;
    for (const item of items) {
      const itemId = item.ebayItemId || item.itemId;
      if (!itemId) continue;
      try {
        await reviseFixedPriceItem({ itemId: String(itemId), quantity: 0 });
        revised++;
      } catch (err) {
        console.warn(`[marketplace-cancel] eBay revise item ${itemId} failed: ${err.message}`);
      }
    }

    console.log(`[marketplace-cancel] eBay cancel for order ${ebayOrderId}: revised ${revised} item(s), reason=${reason || 'n/a'}`);
    return { ok: true, marketplace: 'ebay', revised };
  } catch (err) {
    console.error(`[marketplace-cancel] eBay cancel failed: ${err.message}`);
    return { ok: false, marketplace: 'ebay', error: err.message };
  }
}

/**
 * Cancel a Kaufland order by cancelling each order unit.
 * Kaufland API: PATCH /v2/order-units/{unitId}/cancel
 *
 * @param {{ order: object, reason?: string, note?: string }} opts
 */
async function cancelOrderOnKaufland({ order, reason, note }) {
  try {
    const { kauflandRequest } = require('../lib/kaufland-api');

    const klReason = KAUFLAND_CANCEL_REASONS[reason] || KAUFLAND_CANCEL_REASONS.other;

    const items = order.items || [];
    const unitIds = items.map((item) => item.unitId).filter(Boolean);

    if (unitIds.length === 0) {
      // Fallback: fetch unit IDs from Kaufland API
      const klOrderId = order.marketplaceOrderId || order.externalOrderId;
      if (!klOrderId) return { ok: false, marketplace: 'kaufland', error: 'No Kaufland order/unit IDs' };

      const unitsRes = await kauflandRequest('GET', `/orders/${klOrderId}/units`);
      const units = Array.isArray(unitsRes?.data) ? unitsRes.data : [];
      for (const unit of units) {
        if (unit.id_order_unit) unitIds.push(unit.id_order_unit);
      }
    }

    let successCount = 0;
    let lastError = null;

    for (const unitId of unitIds) {
      try {
        await kauflandRequest('PATCH', `/order-units/${unitId}/cancel`, {
          body: {
            reason: klReason,
            message: note || undefined,
          },
        });
        successCount++;
      } catch (err) {
        lastError = err.message;
        console.error(`[marketplace-cancel] Kaufland unit ${unitId} cancel failed: ${err.message}`);
      }
    }

    if (successCount === 0 && unitIds.length > 0) {
      return { ok: false, marketplace: 'kaufland', error: lastError || 'All unit cancellations failed' };
    }

    console.log(`[marketplace-cancel] Kaufland: ${successCount}/${unitIds.length} units cancelled for order ${order.marketplaceOrderId}`);
    return { ok: true, marketplace: 'kaufland', unitsCancelled: successCount };
  } catch (err) {
    console.error(`[marketplace-cancel] Kaufland cancel failed: ${err.message}`);
    return { ok: false, marketplace: 'kaufland', error: err.message };
  }
}

/**
 * Escape XML special characters.
 */
function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = {
  pushTrackingToMarketplace,
  pushTrackingToEbay,
  pushTrackingToKaufland,
  ensureMarketplaceTrackingPushed,
  retryFailedMarketplacePushes,
  pushCancellationToMarketplace,
  cancelOrderOnEbay,
  cancelOrderOnKaufland,
  normalizeKauflandCarrier,
  EBAY_CARRIER_MAP,
  KAUFLAND_CARRIER_MAP,
  KAUFLAND_CANCEL_REASONS,
};
