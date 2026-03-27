'use strict';

/**
 * shipping-engine.js — SendCloud Label-Erzeugung & Parcel-Management.
 *
 * Creates shipping labels via SendCloud API v2, manages parcels,
 * and provides carrier rule matching for automated shipping.
 */

const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { getSecretValue } = require('../lib/secret-values');
const { lookupCsvPrice } = require('../lib/sendcloud');

const SENDCLOUD_BASE_URL = 'https://panel.sendcloud.sc/api/v2';
const SHIPMENTS_COLLECTION = 'shipments';
const ORDERS_COLLECTION = 'orders';

// Default carrier rules — used as fallback when no rules configured in Firestore
const DEFAULT_CARRIER_RULES = [
  { minWeight: 0.5, maxWeight: 1.99, shippingMethodId: 2830, carrier: 'dhl', label: 'DHL Kleinpaket 0-1kg' },
  { minWeight: 2,   maxWeight: 4.99, shippingMethodId: 111,  carrier: 'dpd', label: 'DPD Classic 0-5 kg' },
  { minWeight: 5,   maxWeight: 9.99, shippingMethodId: 112,  carrier: 'dpd', label: 'DPD Classic 5-10 kg' },
  { minWeight: 10,  maxWeight: 31.5, shippingMethodId: 113,  carrier: 'dpd', label: 'DPD Classic 10-20 kg' },
];

let _db;
function getDb() {
  if (!_db) _db = new Firestore();
  return _db;
}

/**
 * Map SendCloud numeric status IDs to internal shipment statuses.
 * https://support.sendcloud.sc/hc/en-us/articles/360024967612
 */
function mapSendCloudStatus(statusId) {
  const id = Number(statusId || 0);
  // Delivered states
  if (id === 11 || id === 6) return 'zugestellt';
  // In transit states
  if (id === 3 || id === 4 || id === 5 || id === 91) return 'in_zustellung';
  // Created / ready / announced
  if (id === 1 || id === 1000 || id === 1001 || id === 62989) return 'ausstehend';
  // Problem states
  if (id === 1002 || id === 8 || id === 80 || id === 999) return 'problem';
  // Cancelled
  if (id === 2000) return 'storniert';
  // Fallback
  return 'ausstehend';
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
 * Normalize a name for fuzzy matching.
 * "Dr.Marin,Christian" → "christian marin dr"
 * Removes punctuation, lowercases, splits + sorts parts alphabetically.
 */
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.,;:\-_\/\\'"()]/g, ' ')
    .split(/\s+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .sort()
    .join(' ');
}

/**
 * Split a combined address string into street name + house number.
 * German pattern: "Musterstraße 12a" → { street: "Musterstraße", houseNumber: "12a" }
 * If no number found, returns houseNumber = '-' (SendCloud requires a non-blank value).
 */
function splitAddressLine(addressStr) {
  const s = String(addressStr || '').trim();
  // Match: everything before the trailing number (with optional letter suffix)
  const match = s.match(/^(.*?)\s+(\d+\s*[a-zA-Z\-\/]*)$/);
  if (match) {
    return { street: match[1].trim(), houseNumber: match[2].trim() };
  }
  return { street: s, houseNumber: '-' };
}

/**
 * Extract label URL from a SendCloud parcel object.
 * Returns null if no label has been generated yet.
 */
function extractLabelUrl(parcel, isA4) {
  if (!parcel || !parcel.label) return null;
  if (isA4) {
    return parcel.label.normal_printer?.[0] || parcel.label.label_printer || null;
  }
  return parcel.label.label_printer || parcel.label.normal_printer?.[0] || null;
}

/**
 * Poll SendCloud parcel API until label is generated.
 * SendCloud generates labels asynchronously — may take a few seconds.
 */
async function pollForLabel({ parcelId, labelFormat = 'a6', maxAttempts = 10, intervalMs = 2000 }) {
  const auth = await getSendCloudAuth();
  const isA4 = labelFormat === 'a4';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, intervalMs));

    const res = await fetch(`${SENDCLOUD_BASE_URL}/parcels/${parcelId}`, {
      headers: { Authorization: auth },
    });

    if (!res.ok) {
      console.warn(`[pollForLabel] GET parcel ${parcelId} returned ${res.status} on attempt ${attempt}`);
      continue;
    }

    const data = await res.json();
    const parcel = data?.parcel || {};
    const labelUrl = extractLabelUrl(parcel, isA4);

    if (labelUrl) {
      return { labelUrl, parcel, status: parcel.status?.message };
    }

    console.log(`[pollForLabel] Attempt ${attempt}/${maxAttempts} — label not ready yet (status: ${parcel.status?.message || 'unknown'})`);
  }

  return { labelUrl: null, parcel: null, status: 'timeout' };
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
 *   labelFormat?: 'a6' | 'a4',
 * }} opts
 * @returns {Promise<{ parcel: object, labelUrl: string | null, trackingNumber: string | null }>}
 */
async function createParcel({
  order,
  shippingMethodId,
  weight,
  requestLabel = true,
  tenantId = 'default',
  labelFormat = 'a6',
}) {
  if (!order) throw new Error('order is required');

  const customer = order.customer || {};
  const auth = await getSendCloudAuth();

  // Resolve address fields — try multiple field names for robustness
  // Convert to string to handle numeric values stored from marketplace APIs
  const rawAddress = String(customer.street
    || customer.address
    || customer.address_1
    || customer.strasse
    || [customer.streetName, customer.houseNumber].filter(Boolean).join(' ')
    || '');
  const cityStr = String(customer.city || customer.ort || '');
  // PLZ-Sanitierung: eBay liefert zip als Number (z.B. 1069 statt "01069"), Kaufland als String.
  // Deutsche PLZ müssen 5-stellig sein, mit führender Null wenn nötig.
  const rawZipValue = customer.zip ?? customer.postal_code ?? customer.postcode ?? customer.plz ?? '';
  let zipStr = String(rawZipValue).trim().replace(/\s+/g, '').replace(/[^a-zA-Z0-9-]/g, '');
  const countryRaw = String(customer.country || customer.countryCode || 'DE').trim().toUpperCase().slice(0, 2);
  // Pad German/Austrian zip codes to 5/4 digits if they were stored as numbers (leading zeros lost)
  if (countryRaw === 'DE' && /^\d{1,4}$/.test(zipStr)) {
    zipStr = zipStr.padStart(5, '0');
  } else if (countryRaw === 'AT' && /^\d{1,3}$/.test(zipStr)) {
    zipStr = zipStr.padStart(4, '0');
  }
  if (String(rawZipValue) !== zipStr) {
    console.warn(`[createParcel] Sanitized zip: "${rawZipValue}" → "${zipStr}" (order: ${order.id || order.marketplaceOrderId}, country: ${countryRaw})`);
  }
  const nameStr = String(customer.name
    || [customer.firstName, customer.lastName].filter(Boolean).join(' ')
    || 'Unbekannt');

  // Split address into street name + house number (SendCloud requires them separate)
  const explicitHouseNumber = String(customer.houseNumber || customer.house_number || '');
  const { street: parsedStreet, houseNumber: parsedHouseNumber } = splitAddressLine(rawAddress);
  const addressStr = parsedStreet;
  const houseNumberStr = explicitHouseNumber || parsedHouseNumber;

  // Validate required fields before calling SendCloud
  const missingFields = [];
  if (!addressStr.trim()) missingFields.push('Straße (customer.street)');
  if (!cityStr.trim()) missingFields.push('Stadt (customer.city)');
  if (!zipStr.trim()) missingFields.push('PLZ (customer.zip)');
  if (!nameStr.trim() || nameStr === 'Unbekannt') missingFields.push('Name (customer.name)');

  if (missingFields.length > 0) {
    throw new Error(
      `Versandlabel kann nicht erstellt werden — fehlende Adressdaten: ${missingFields.join(', ')}. ` +
      `Bitte Kundendaten im Auftrag vervollständigen.`
    );
  }

  // Calculate total weight from items if not provided
  const totalWeight = weight || calculateOrderWeight(order);

  // Build parcel payload per SendCloud API v2
  const parcelData = {
    parcel: {
      name: nameStr,
      address: addressStr,
      house_number: houseNumberStr,
      city: cityStr,
      postal_code: zipStr,
      country: countryRaw,
      email: customer.email || 'noreply@trendocean.de',
      telephone: customer.phone || customer.telephone || '',
      order_number: order.marketplaceOrderId || order.orderId || order.id || '',
      weight: String(totalWeight || 0.5), // kg
      request_label: requestLabel,
      external_reference: `${order.marketplaceOrderId || order.id || ''}_${Date.now()}`,
    },
  };

  if (shippingMethodId) {
    parcelData.parcel.shipment = { id: shippingMethodId };
  }

  console.log(`[createParcel] Payload for ${order.id}: postal_code="${zipStr}", country="${countryRaw}", city="${cityStr}", address="${addressStr}", house_number="${houseNumberStr}", name="${nameStr}"`);
  console.log(`[createParcel] Raw customer zip: ${JSON.stringify(customer.zip)}, type: ${typeof customer.zip}, postal_code: ${JSON.stringify(customer.postal_code)}`);

  // Retry with exponential backoff (3 attempts: 0s, 1s, 3s)
  const MAX_RETRIES = 3;
  const BACKOFF_BASE_MS = 1000;
  let res;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    res = await fetch(`${SENDCLOUD_BASE_URL}/parcels?errors=verbose-carrier`, {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(parcelData),
    });

    if (res.ok) break;

    const body = await res.text().catch(() => '');
    // Only retry on transient errors (429, 5xx)
    if (attempt < MAX_RETRIES && (res.status >= 500 || res.status === 429)) {
      const delay = BACKOFF_BASE_MS * Math.pow(3, attempt - 1);
      console.warn(`[createParcel] SendCloud ${res.status}, retry ${attempt}/${MAX_RETRIES} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    throw new Error(`SendCloud create parcel ${res.status}: ${body.slice(0, 300)}`);
  }

  const result = await res.json();
  let parcel = result?.parcel || {};

  const trackingNumber = parcel.tracking_number || null;
  const isA4 = labelFormat === 'a4';

  // Extract label URL from response — NEVER construct from parcel ID
  let labelUrl = extractLabelUrl(parcel, isA4);

  // If label not in immediate response, poll parcel API until label is ready
  if (!labelUrl && parcel.id) {
    console.log(`[createParcel] No label in POST response (parcel ${parcel.id}), polling for label...`);
    const polled = await pollForLabel({ parcelId: parcel.id, labelFormat, maxAttempts: 10, intervalMs: 2000 });
    if (polled.labelUrl) {
      labelUrl = polled.labelUrl;
      parcel = polled.parcel || parcel;
      console.log(`[createParcel] Label ready after polling (parcel ${parcel.id})`);
    } else {
      console.warn(`[createParcel] Label NOT generated by SendCloud after polling (parcel ${parcel.id}). Status: ${polled.status || 'unknown'}`);
    }
  }

  // Save shipment record to Firestore
  const shipmentDoc = {
    tenantId,
    orderId: order.id || order.orderId || null,
    orderNumber: order.marketplaceOrderId || order.orderId || null,
    marketplaceOrderId: order.marketplaceOrderId || null,
    marketplace: order.marketplace || order.source || null,
    sendcloudParcelId: parcel.id || null,
    trackingNumber,
    trackingUrl: parcel.tracking_url || null,
    labelUrl,
    carrier: parcel.carrier?.code || null,
    carrierName: parcel.carrier?.code || null,
    shippingMethodId: shippingMethodId || parcel.shipment?.id || null,
    weight: totalWeight,
    status: mapSendCloudStatus(parcel.status?.id),
    statusRaw: parcel.status?.message || 'created',
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
 * @param {{ parcelId: number, labelFormat?: 'a6' | 'a4' }} opts
 * @returns {Promise<{ labelUrl: string | null }>}
 */
async function getLabel({ parcelId, labelFormat = 'a6' }) {
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
  const isA4 = labelFormat === 'a4';
  const labelUrl = extractLabelUrl(parcel, isA4);
  return {
    labelUrl,
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
 * Returns null if no weight data available — no silent fallback.
 * @param {object} order
 * @returns {number|null} weight in kg, or null if unknown
 */
function calculateOrderWeight(order) {
  // 1. Order-level weight (manually set or enriched from products)
  const orderLevelWeight = parseFloat(order.weight || '0') || 0;
  if (orderLevelWeight > 0) return orderLevelWeight;

  // 2. Sum of item weights
  const items = order.items || [];
  let totalKg = 0;
  for (const item of items) {
    const w = parseFloat(item.weight || '0') || 0;
    totalKg += w * (item.quantity || 1);
  }
  if (totalKg > 0) return totalKg;

  // 3. No fallback — weight must be explicitly set
  return null;
}

/**
 * Match shipping method based on carrier rules from order_settings.
 *
 * Rules format:
 *   { minWeight?: number, maxWeight: number, shippingMethodId: number, carrier: string, label: string }
 *
 * Example rules:
 *   { minWeight: 0.5, maxWeight: 1.99, shippingMethodId: 89, carrier: 'dhl', label: 'DHL Kleinpaket' }
 *   { minWeight: 2,   maxWeight: 4.99, shippingMethodId: 201, carrier: 'dpd', label: 'DPD Classic 0-5 kg' }
 *
 * @param {{ weight: number, rules: object[] }} opts
 * @returns {{ shippingMethodId: number, carrier: string, label: string } | null}
 */
function matchCarrierRule({ weight, rules }) {
  if (!Array.isArray(rules) || rules.length === 0) return null;

  const w = Number(weight) || 0;

  // Sort by maxWeight ascending (type-safe)
  const sorted = [...rules].sort((a, b) => (Number(a.maxWeight) || 0) - (Number(b.maxWeight) || 0));

  // Find first rule where weight is within [minWeight, maxWeight]
  for (const rule of sorted) {
    const min = Number(rule.minWeight) || 0;
    const max = Number(rule.maxWeight) || Infinity;
    if (w >= min && w <= max) {
      return {
        shippingMethodId: rule.shippingMethodId,
        carrier: rule.carrier || 'unknown',
        label: rule.label || rule.carrier || 'Standard',
      };
    }
  }

  // Fallback: if weight exceeds all rules, use the largest rule
  const last = sorted[sorted.length - 1];
  if (w > (Number(last.maxWeight) || 0)) {
    return {
      shippingMethodId: last.shippingMethodId,
      carrier: last.carrier || 'unknown',
      label: last.label || last.carrier || 'Standard',
    };
  }

  // Weight below all rules (e.g. under minimum) — no match
  return null;
}

/**
 * Create a shipping label for an order, auto-selecting carrier based on rules.
 *
 * Full flow: load order → calculate weight → match carrier rule → create SendCloud parcel
 * → update order status to 'shipped'
 *
 * @param {{ orderId: string, tenantId?: string, shippingMethodId?: number, weight?: number, labelFormat?: 'a6' | 'a4' }} opts
 * @returns {Promise<object>}
 */
async function shipOrder({ orderId, tenantId = 'default', shippingMethodId, weight, labelFormat = 'a6' }) {
  const db = getDb();

  // Load order
  const orderSnap = await db.collection(ORDERS_COLLECTION).doc(orderId).get();
  if (!orderSnap.exists) throw new Error('Auftrag nicht gefunden');
  const order = { id: orderSnap.id, ...orderSnap.data() };

  // Calculate weight
  const orderWeight = weight || calculateOrderWeight(order);
  if (!orderWeight) {
    throw new Error(
      'Versand nicht moeglich: Bestellgewicht fehlt. Bitte Gewicht in den Bestelldetails eintragen.'
    );
  }

  // Auto-select shipping method from rules if not provided
  let methodId = shippingMethodId;
  let matchedRule = null;
  if (!methodId) {
    const settingsSnap = await db.collection('order_settings').doc(tenantId).get();
    const settings = settingsSnap.exists ? settingsSnap.data() : {};
    const rules = settings.carrierRules?.length ? settings.carrierRules : DEFAULT_CARRIER_RULES;
    matchedRule = matchCarrierRule({ weight: orderWeight, rules });
    if (!matchedRule) {
      throw new Error(
        `Keine passende Versandregel für Gewicht ${orderWeight.toFixed(2)} kg gefunden. ` +
        `Bitte Versandregeln prüfen oder Gewicht korrigieren.`
      );
    }
    methodId = matchedRule.shippingMethodId;
  }

  // Create parcel in SendCloud
  const result = await createParcel({
    order,
    shippingMethodId: methodId,
    weight: orderWeight,
    requestLabel: true,
    tenantId,
    labelFormat,
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

/**
 * Download a SendCloud label PDF as a Buffer (proxied with auth).
 * SendCloud generates label PDFs asynchronously — the label_printer endpoint
 * may return 404 for a few seconds after parcel creation. We retry with backoff.
 * @param {string} labelUrl — full SendCloud label URL
 * @param {{ maxRetries?: number, retryDelayMs?: number }} retryOpts
 * @returns {Promise<{ buffer: Buffer, contentType: string }>}
 */
async function downloadLabelPdf(labelUrl, { maxRetries = 8, retryDelayMs = 2000 } = {}) {
  if (!labelUrl) throw new Error('No label URL provided');
  const auth = await getSendCloudAuth();

  let lastStatus = 0;
  let lastBody = '';
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
    const res = await fetch(labelUrl, {
      headers: { Authorization: auth },
    });
    if (res.ok) {
      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') || 'application/pdf';
      if (attempt > 0) {
        console.log(`[downloadLabelPdf] Label ready after ${attempt} retries`);
      }
      return { buffer, contentType };
    }
    lastStatus = res.status;
    lastBody = await res.text().catch(() => '');
    // Only retry on 404 (label not yet generated) or 429 (rate limit)
    if (res.status !== 404 && res.status !== 429) {
      throw new Error(`SendCloud label download ${res.status}: ${lastBody.slice(0, 200)}`);
    }
    if (attempt < maxRetries) {
      console.log(`[downloadLabelPdf] Attempt ${attempt + 1}/${maxRetries + 1} got ${res.status}, retrying in ${retryDelayMs}ms...`);
    }
  }
  throw new Error(`SendCloud label download ${lastStatus} after ${maxRetries + 1} attempts: ${lastBody.slice(0, 200)}`);
}

/**
 * Sync SendCloud parcels into AvyCloud — match existing orders by order_number,
 * external_reference, or customer name+zip fallback.
 *
 * @param {{ tenantId?: string, fromDate?: string, toDate?: string }} opts
 * @returns {Promise<{ matched: object[], unmatched: object[], skipped: number }>}
 */
async function syncSendCloudParcels({ tenantId = 'default', fromDate, toDate } = {}) {
  const auth = await getSendCloudAuth();
  const db = getDb();

  // Default date range: last 14 days
  if (!fromDate) {
    const d = new Date();
    d.setDate(d.getDate() - 14);
    fromDate = d.toISOString().slice(0, 10);
  }
  if (!toDate) {
    toDate = new Date().toISOString().slice(0, 10);
  }

  // Load existing shipment parcel IDs to skip already-synced
  const existingSnap = await db.collection(SHIPMENTS_COLLECTION)
    .select('sendcloudParcelId')
    .limit(5000)
    .get();
  const existingParcelIds = new Set();
  for (const doc of existingSnap.docs) {
    const pid = doc.data().sendcloudParcelId;
    if (pid) existingParcelIds.add(Number(pid));
  }

  // Fetch parcels from SendCloud with pagination
  const allParcels = [];
  let page = 1;
  const limit = 100;

  while (true) {
    const params = new URLSearchParams({
      from_date: fromDate,
      to_date: toDate,
      limit: String(limit),
      offset: String((page - 1) * limit),
    });

    const res = await fetch(`${SENDCLOUD_BASE_URL}/parcels?${params}`, {
      headers: { Authorization: auth },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`SendCloud parcels fetch ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const parcels = Array.isArray(data?.parcels) ? data.parcels : [];
    allParcels.push(...parcels);

    if (parcels.length < limit) break;
    if (page > 50) break; // Safety limit
    page++;
  }

  // Load all orders for matching
  const ordersSnap = await db.collection(ORDERS_COLLECTION).limit(5000).get();
  const ordersById = new Map();
  const ordersByNumber = new Map();
  const ordersByMarketplaceId = new Map();
  const ordersByNameZip = new Map();

  for (const doc of ordersSnap.docs) {
    const o = { id: doc.id, ...doc.data() };
    ordersById.set(doc.id, o);
    ordersByNumber.set(doc.id, o); // Firestore doc ID for matching parcels created with order.id

    if (o.orderId) ordersByNumber.set(String(o.orderId), o);
    if (o.number) ordersByNumber.set(String(o.number), o);
    if (o.marketplaceOrderId) ordersByMarketplaceId.set(String(o.marketplaceOrderId), o);

    const normName = normalizeName(String(o.customer?.name || ''));
    const normZip = String(o.customer?.zip || o.customer?.postal_code || o.customer?.plz || '').trim();
    const nameZipKey = `${normName}::${normZip}`;
    if (nameZipKey !== '::') ordersByNameZip.set(nameZipKey, o);
  }

  const matched = [];
  const unmatched = [];
  let skipped = 0;

  for (const parcel of allParcels) {
    const parcelId = parcel.id;

    // Skip already synced
    if (existingParcelIds.has(Number(parcelId))) {
      skipped++;
      continue;
    }

    // Skip cancelled parcels
    const statusId = Number(parcel.status?.id || 0);
    if (statusId === 2000) {
      skipped++;
      continue;
    }

    // Try to match to an order
    let order = null;
    const orderNumber = parcel.order_number || '';
    const extRef = parcel.external_reference || '';

    // Priority 1: order_number → try marketplace ID, then Firestore doc ID, then orderId/number
    if (orderNumber) {
      order = ordersByMarketplaceId.get(orderNumber) || ordersById.get(orderNumber) || ordersByNumber.get(orderNumber) || null;
    }

    // Priority 2: external_reference → marketplaceOrderId, then by number
    if (!order && extRef) {
      order = ordersByMarketplaceId.get(extRef) || ordersById.get(extRef) || ordersByNumber.get(extRef) || null;
    }

    // Priority 3: name + zip fallback (normalized for fuzzy matching)
    if (!order) {
      const name = normalizeName(parcel.name || '');
      const zip = String(parcel.postal_code || '').trim();
      if (name && zip) {
        order = ordersByNameZip.get(`${name}::${zip}`) || null;
      }
    }

    if (!order) {
      unmatched.push({
        parcelId,
        orderNumber,
        externalReference: extRef,
        name: parcel.name,
        trackingNumber: parcel.tracking_number,
        carrier: parcel.carrier?.code,
      });
      continue;
    }

    // Create shipment record
    const trackingNumber = parcel.tracking_number || null;
    const trackingUrl = parcel.tracking_url || null;
    const carrier = parcel.carrier?.code || null;
    const labelUrl = extractLabelUrl(parcel, false);

    // Map SendCloud status to internal status
    const scStatus = mapSendCloudStatus(statusId);

    // Extract cost from parcel — CSV fallback when SendCloud API has no price
    let parcelCost = parseFloat(String(parcel.price || '0').replace(',', '.')) || 0;
    if (parcelCost === 0) {
      const methodId = parcel.shipment?.id ?? parcel.shipment_product?.id ?? 0;
      const weightKg = parseFloat(String(parcel.weight || '0').replace(',', '.')) || 0;
      if (methodId && weightKg > 0) {
        parcelCost = lookupCsvPrice(methodId, weightKg);
      }
    }

    // Customer name from order — BUG-062: more fallbacks for missing name
    const customerName = order.customer?.name
      || (order.customer?.firstName ? `${order.customer.firstName} ${order.customer.lastName || ''}`.trim() : null)
      || parcel.name
      || parcel.address?.name
      || parcel.address?.company_name
      || null;

    // Dates
    const parcelCreated = parcel.date_created || parcel.created_at || null;
    const shippedAt = parcelCreated || new Date().toISOString();

    const shipmentDoc = {
      tenantId,
      orderId: order.id,
      orderNumber: order.marketplaceOrderId || order.orderId || null,
      marketplaceOrderId: order.marketplaceOrderId || null,
      marketplace: order.marketplace || order.source || null,
      sendcloudParcelId: parcelId,
      trackingNumber,
      trackingUrl,
      labelUrl,
      carrier: (carrier || '').toUpperCase().replace('_DE', ''),
      carrierName: carrier,
      customer: customerName,
      weight: parcel.weight ? Number(parcel.weight) : null,
      cost: parcelCost,
      status: scStatus,
      statusId: parcel.status?.id || null,
      statusRaw: parcel.status?.message || null,
      shippedAt,
      deliveredAt: scStatus === 'zugestellt' ? (parcel.date_updated || new Date().toISOString()) : null,
      source: 'sendcloud_sync',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const shipRef = await db.collection(SHIPMENTS_COLLECTION).add(shipmentDoc);

    // Update order with tracking info
    const orderUpdate = {
      trackingNumber,
      trackingUrl,
      shippingService: carrier,
      shipmentId: shipRef.id,
      updatedAt: new Date().toISOString(),
    };
    await db.collection(ORDERS_COLLECTION).doc(order.id).set(orderUpdate, { merge: true });

    // Auto-transition to shipped only if tracking is confirmed and order is in a valid pre-ship state
    const currentStatus = order.omsStatus || order.status || 'pending';
    if (trackingNumber && ['packed', 'picked', 'packing'].includes(currentStatus)) {
      const { transitionOrder } = require('./order-state-machine');
      await transitionOrder({
        tenantId,
        orderId: order.id,
        toStatus: 'shipped',
        actor: { uid: 'system', email: 'sendcloud-sync' },
        note: `SendCloud Sync — Label ${carrier || '?'} (${trackingNumber})`,
        force: true,
        timestamps: { shippedAt: new Date().toISOString() },
      }).catch((err) => console.warn(`[syncSendCloud] Transition failed for ${order.id}: ${err.message}`));
    }

    matched.push({
      parcelId,
      orderId: order.id,
      orderNumber: order.marketplaceOrderId || order.orderId,
      trackingNumber,
      carrier,
    });

    existingParcelIds.add(Number(parcelId));
  }

  console.log(`[syncSendCloud] ${matched.length} matched, ${unmatched.length} unmatched, ${skipped} skipped`);
  return { matched, unmatched, skipped };
}

module.exports = {
  getShippingMethods,
  createParcel,
  getLabel,
  cancelParcel,
  calculateOrderWeight,
  matchCarrierRule,
  shipOrder,
  downloadLabelPdf,
  syncSendCloudParcels,
};
