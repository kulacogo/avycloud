'use strict';

/**
 * shipping-engine.js — SendCloud Label-Erzeugung & Parcel-Management.
 *
 * Creates shipping labels via SendCloud API v2, manages parcels,
 * and provides carrier rule matching for automated shipping.
 */

const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { getSecretValue } = require('../lib/secret-values');

const SENDCLOUD_BASE_URL = 'https://panel.sendcloud.sc/api/v2';
const SHIPMENTS_COLLECTION = 'shipments';
const ORDERS_COLLECTION = 'orders';

let _db;
function getDb() {
  if (!_db) _db = new Firestore();
  return _db;
}

let _cachedAuth = null;
async function getSendCloudAuth() {
  if (_cachedAuth) return _cachedAuth;
  const [pub, sec] = await Promise.all([
    getSecretValue('SENDCLOUD_PUBLIC_KEY'),
    getSecretValue('SENDCLOUD_SECRET_KEY'),
  ]);
  if (!pub || !sec) throw new Error('SENDCLOUD credentials not configured');
  _cachedAuth = 'Basic ' + Buffer.from(`${pub}:${sec}`).toString('base64');
  return _cachedAuth;
}

/**
 * Fetch available shipping methods from SendCloud.
 * @returns {Promise<object[]>}
 */
async function getShippingMethods() {
  const auth = await getSendCloudAuth();
  const res = await fetch(`${SENDCLOUD_BASE_URL}/shipping_methods`, {
    headers: { Authorization: auth },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SendCloud shipping_methods ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data?.shipping_methods || [];
}

/**
 * Create a parcel (shipping label) in SendCloud.
 *
 * @param {{
 *   order: object,
 *   shippingMethodId?: number,
 *   weight?: number,
 *   requestLabel?: boolean,
 *   tenantId?: string,
 * }} opts
 * @returns {Promise<{ parcel: object, labelUrl: string | null, trackingNumber: string | null }>}
 */
async function createParcel({
  order,
  shippingMethodId,
  weight,
  requestLabel = true,
  tenantId = 'default',
}) {
  if (!order) throw new Error('order is required');

  const customer = order.customer || {};
  const auth = await getSendCloudAuth();

  // Calculate total weight from items if not provided
  const totalWeight = weight || calculateOrderWeight(order);

  // Build parcel payload per SendCloud API v2
  const parcelData = {
    parcel: {
      name: customer.name || 'Unbekannt',
      address: customer.street || '',
      city: customer.city || '',
      postal_code: customer.zip || '',
      country: customer.country || 'DE',
      email: customer.email || '',
      telephone: customer.phone || '',
      order_number: order.orderId || order.id || '',
      weight: String(Math.round((totalWeight || 0.5) * 1000)), // grams
      request_label: requestLabel,
      external_reference: order.marketplaceOrderId || order.id || '',
    },
  };

  if (shippingMethodId) {
    parcelData.parcel.shipment = { id: shippingMethodId };
  }

  const res = await fetch(`${SENDCLOUD_BASE_URL}/parcels`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(parcelData),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SendCloud create parcel ${res.status}: ${body.slice(0, 300)}`);
  }

  const result = await res.json();
  const parcel = result?.parcel || {};

  const trackingNumber = parcel.tracking_number || null;
  const labelUrl = parcel.label?.label_printer || parcel.label?.normal_printer?.[0] || null;

  // Save shipment record to Firestore
  const shipmentDoc = {
    tenantId,
    orderId: order.id || order.orderId || null,
    orderNumber: order.orderId || order.number || null,
    sendcloudParcelId: parcel.id || null,
    trackingNumber,
    trackingUrl: parcel.tracking_url || null,
    labelUrl,
    carrier: parcel.carrier?.code || null,
    carrierName: parcel.carrier?.code || null,
    shippingMethodId: shippingMethodId || parcel.shipment?.id || null,
    weight: totalWeight,
    status: parcel.status?.message || 'created',
    statusId: parcel.status?.id || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const shipRef = await getDb().collection(SHIPMENTS_COLLECTION).add(shipmentDoc);

  return {
    shipmentId: shipRef.id,
    parcel,
    trackingNumber,
    trackingUrl: parcel.tracking_url || null,
    labelUrl,
    carrier: parcel.carrier?.code || null,
  };
}

/**
 * Get label PDF URL for an existing parcel.
 * @param {{ parcelId: number }} opts
 * @returns {Promise<{ labelUrl: string | null }>}
 */
async function getLabel({ parcelId }) {
  const auth = await getSendCloudAuth();
  const res = await fetch(`${SENDCLOUD_BASE_URL}/parcels/${parcelId}`, {
    headers: { Authorization: auth },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SendCloud get parcel ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const parcel = data?.parcel || {};
  return {
    labelUrl: parcel.label?.label_printer || parcel.label?.normal_printer?.[0] || null,
    trackingNumber: parcel.tracking_number || null,
    status: parcel.status?.message || null,
  };
}

/**
 * Cancel a parcel in SendCloud.
 * @param {{ parcelId: number, tenantId?: string }} opts
 * @returns {Promise<{ ok: boolean }>}
 */
async function cancelParcel({ parcelId, tenantId = 'default' }) {
  const auth = await getSendCloudAuth();
  const res = await fetch(`${SENDCLOUD_BASE_URL}/parcels/${parcelId}/cancel`, {
    method: 'POST',
    headers: { Authorization: auth },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SendCloud cancel parcel ${res.status}: ${body.slice(0, 200)}`);
  }

  // Update shipment record
  const snap = await getDb().collection(SHIPMENTS_COLLECTION)
    .where('sendcloudParcelId', '==', parcelId)
    .limit(1)
    .get();

  if (!snap.empty) {
    await snap.docs[0].ref.set(
      { status: 'cancelled', updatedAt: new Date().toISOString() },
      { merge: true }
    );
  }

  return { ok: true };
}

/**
 * Calculate order weight from items.
 * Falls back to 0.5kg if no weight data available.
 * @param {object} order
 * @returns {number} weight in kg
 */
function calculateOrderWeight(order) {
  const items = order.items || [];
  let totalKg = 0;
  for (const item of items) {
    const w = parseFloat(item.weight || '0') || 0;
    totalKg += w * (item.quantity || 1);
  }
  return totalKg > 0 ? totalKg : 0.5; // Default 500g if unknown
}

/**
 * Match shipping method based on carrier rules from order_settings.
 *
 * Rules: { maxWeight: number, shippingMethodId: number, carrier: string, label: string }
 *
 * @param {{ weight: number, rules: object[] }} opts
 * @returns {{ shippingMethodId: number, carrier: string, label: string } | null}
 */
function matchCarrierRule({ weight, rules }) {
  if (!Array.isArray(rules) || rules.length === 0) return null;

  // Sort by maxWeight ascending, pick the first rule where weight fits
  const sorted = [...rules].sort((a, b) => (a.maxWeight || 0) - (b.maxWeight || 0));
  for (const rule of sorted) {
    if (weight <= (rule.maxWeight || Infinity)) {
      return {
        shippingMethodId: rule.shippingMethodId,
        carrier: rule.carrier || 'unknown',
        label: rule.label || rule.carrier || 'Standard',
      };
    }
  }

  // If weight exceeds all rules, use the largest
  const last = sorted[sorted.length - 1];
  return {
    shippingMethodId: last.shippingMethodId,
    carrier: last.carrier || 'unknown',
    label: last.label || last.carrier || 'Standard',
  };
}

/**
 * Create a shipping label for an order, auto-selecting carrier based on rules.
 *
 * Full flow: load order → calculate weight → match carrier rule → create SendCloud parcel
 * → update order status to 'shipped'
 *
 * @param {{ orderId: string, tenantId?: string, shippingMethodId?: number, weight?: number }} opts
 * @returns {Promise<object>}
 */
async function shipOrder({ orderId, tenantId = 'default', shippingMethodId, weight }) {
  const db = getDb();

  // Load order
  const orderSnap = await db.collection(ORDERS_COLLECTION).doc(orderId).get();
  if (!orderSnap.exists) throw new Error('Auftrag nicht gefunden');
  const order = { id: orderSnap.id, ...orderSnap.data() };

  // Calculate weight
  const orderWeight = weight || calculateOrderWeight(order);

  // Auto-select shipping method from rules if not provided
  let methodId = shippingMethodId;
  if (!methodId) {
    const settingsSnap = await db.collection('order_settings').doc(tenantId).get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const rules = settings.carrierRules || [];
    const matched = matchCarrierRule({ weight: orderWeight, rules });
    if (matched) {
      methodId = matched.shippingMethodId;
    }
  }

  // Create parcel in SendCloud
  const result = await createParcel({
    order,
    shippingMethodId: methodId,
    weight: orderWeight,
    requestLabel: true,
    tenantId,
  });

  // Update order with tracking info
  await orderSnap.ref.set({
    trackingNumber: result.trackingNumber,
    trackingUrl: result.trackingUrl,
    shippingService: result.carrier,
    shipmentId: result.shipmentId,
    updatedAt: new Date().toISOString(),
  }, { merge: true });

  return result;
}

module.exports = {
  getShippingMethods,
  createParcel,
  getLabel,
  cancelParcel,
  calculateOrderWeight,
  matchCarrierRule,
  shipOrder,
};
