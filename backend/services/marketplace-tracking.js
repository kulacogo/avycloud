'use strict';

/**
 * marketplace-tracking.js — Push tracking info back to eBay & Kaufland.
 *
 * After a shipping label is created, this service notifies the marketplace
 * that the order has shipped, providing tracking number and carrier.
 */

const { Firestore } = require('@google-cloud/firestore');

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
 */
const KAUFLAND_CARRIER_MAP = {
  dhl: 'DHL',
  'dhl-de': 'DHL',
  dhl_express: 'DHL_EXPRESS',
  dpd: 'DPD',
  'dpd-de': 'DPD',
  hermes: 'HERMES',
  gls: 'GLS',
  ups: 'UPS',
  deutsche_post: 'DEUTSCHE_POST',
};

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
  // Check marketplace, orderSource (from BaseLinker sync), then source
  const marketplace = (order.marketplace || order.orderSource || '').toLowerCase();

  if (marketplace === 'ebay') {
    return pushTrackingToEbay({ order, trackingNumber, carrier });
  }
  if (marketplace === 'kaufland') {
    return pushTrackingToKaufland({ order, trackingNumber, carrier });
  }

  return { ok: true, marketplace, skipped: 'no marketplace push needed' };
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
async function pushTrackingToKaufland({ order, trackingNumber, carrier }) {
  try {
    const { kauflandRequest } = require('../lib/kaufland-api');

    const klCarrier = KAUFLAND_CARRIER_MAP[(carrier || '').toLowerCase()] || carrier || 'OTHER';

    // Kaufland needs per-unit shipment confirmation
    const items = order.items || [];
    const unitIds = items.map((item) => item.unitId).filter(Boolean);

    if (unitIds.length === 0) {
      // Fallback: try order-level shipment if no unit IDs
      const klOrderId = order.marketplaceOrderId || order.externalOrderId;
      if (!klOrderId) return { ok: false, marketplace: 'kaufland', error: 'No Kaufland order/unit IDs' };

      // Try to fetch order units from Kaufland API
      const unitsRes = await kauflandRequest('GET', `/v2/orders/${klOrderId}/units`);
      const units = Array.isArray(unitsRes?.data) ? unitsRes.data : [];
      for (const unit of units) {
        if (unit.id_order_unit) unitIds.push(unit.id_order_unit);
      }
    }

    let successCount = 0;
    let lastError = null;

    for (const unitId of unitIds) {
      try {
        await kauflandRequest('PATCH', `/v2/order-units/${unitId}/ship`, {
          body: {
            tracking_number: trackingNumber,
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
  EBAY_CARRIER_MAP,
  KAUFLAND_CARRIER_MAP,
};
