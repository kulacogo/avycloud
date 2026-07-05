'use strict';

/**
 * shipping-engine.js — SendCloud Label-Erzeugung & Parcel-Management.
 *
 * Creates shipping labels via SendCloud API v2, manages parcels,
 * and provides carrier rule matching for automated shipping.
 */

const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { lookupCsvPrice } = require('../lib/sendcloud');
const { parsePackstation, resolvePostNumber } = require('../lib/packstation');

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

// Ein Auth-Builder für ganz SendCloud (Duplikat entfernt, Review 2026-07-05):
// lib/sendcloud-auth.js — Store gewinnt, 60s-TTL.
async function getSendCloudAuth() {
  const { getSendCloudAuthHeader } = require('../lib/sendcloud-auth');
  return getSendCloudAuthHeader();
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
 * Generate normalized variants of a German street name for SendCloud address validation.
 * Carriers (DPD, DHL) validate against official address DBs — small deviations
 * like "Straße" vs "Str." or missing hyphens cause rejections.
 * Returns an array of unique variants (excluding the original).
 */
function germanAddressVariants(street) {
  const variants = new Set();
  const s = street.trim();

  // "Straße"/"straße" → "Str." and vice versa
  if (/[Ss]tra(?:ß|ss)e\b/.test(s)) {
    variants.add(s.replace(/[Ss]tra(?:ß|ss)e\b/g, 'Str.'));
  }
  if (/\bStr\.\s*$/i.test(s)) {
    variants.add(s.replace(/\bStr\.\s*$/i, 'Straße'));
  }

  // "Str." mid-string with Ortsteil after it (e.g. "Lange Str. Hausen" → "Lange Str.")
  // German rural addresses often embed the Ortsteil (sub-locality) in the street field
  const ortsteilMatch = s.match(/^(.+?\bStr\.)\s+(\S.+)$/i);
  if (ortsteilMatch) {
    const streetOnly = ortsteilMatch[1].trim();
    variants.add(streetOnly); // "Lange Str."
    variants.add(streetOnly.replace(/\bStr\.$/i, 'Straße')); // "Lange Straße"
  }
  // Same for "Straße" mid-string: "Lange Straße Hausen" → "Lange Straße"
  const ortsteilMatch2 = s.match(/^(.+?\b(?:Stra(?:ß|ss)e))\s+(\S.+)$/i);
  if (ortsteilMatch2) {
    const streetOnly = ortsteilMatch2[1].trim();
    variants.add(streetOnly);
    variants.add(streetOnly.replace(/Stra(?:ß|ss)e$/i, 'Str.'));
  }

  // "ß" → "ss" (and reverse)
  if (s.includes('ß')) {
    variants.add(s.replace(/ß/g, 'ss'));
  }

  // Remove the original if it snuck in
  variants.delete(s);
  return [...variants];
}

/**
 * Send parcel creation request to SendCloud with transient-error retry.
 * Returns the fetch Response on success, throws on permanent failure.
 */
async function _sendParcelRequest(parcelData, auth) {
  const MAX_RETRIES = 3;
  const BACKOFF_BASE_MS = 1000;
  let res;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    res = await fetch(`${SENDCLOUD_BASE_URL}/parcels?errors=verbose-carrier`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(parcelData),
    });

    if (res.ok) return res;

    const body = await res.text().catch(() => '');
    if (attempt < MAX_RETRIES && (res.status >= 500 || res.status === 429)) {
      const delay = BACKOFF_BASE_MS * Math.pow(3, attempt - 1);
      console.warn(`[createParcel] SendCloud ${res.status}, retry ${attempt}/${MAX_RETRIES} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    throw new Error(`SendCloud create parcel ${res.status}: ${body.slice(0, 300)}`);
  }
}

/**
 * Extract label URL from a SendCloud parcel object.
 * Falls back to the constructed `/labels/:printer/:parcelId` endpoint when
 * the response body has no populated label URL — required for Deutsche Post
 * Brief / Internetmarke, which generates labels async and often returns an
 * empty `parcel.label` object even though the PDF is retrievable on-demand.
 */
function extractLabelUrl(parcel, isA4) {
  if (!parcel) return null;
  const label = parcel.label || {};
  if (isA4) {
    const fromField = label.normal_printer?.[0] || label.label_printer;
    if (fromField) return fromField;
    return parcel.id ? `${SENDCLOUD_BASE_URL}/labels/normal_printer/${parcel.id}` : null;
  }
  const fromField = label.label_printer || label.normal_printer?.[0];
  if (fromField) return fromField;
  return parcel.id ? `${SENDCLOUD_BASE_URL}/labels/label_printer/${parcel.id}` : null;
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
  let addressStr = parsedStreet;
  let houseNumberStr = explicitHouseNumber || parsedHouseNumber;

  // Detect DHL Packstation/Postfiliale and resolve the required Postnummer.
  // The Postnummer may sit before/after the station token in the address or in
  // an explicit customer field — see lib/packstation.js.
  let toPostNumber = '';
  let isPackstation = false;
  const pack = parsePackstation(rawAddress);
  if (pack.isPackstation) {
    isPackstation = true;
    toPostNumber = resolvePostNumber(pack, customer);
    // SendCloud expects: address = "PACKSTATION 514", house_number = "514", to_post_number = DHL Postnummer
    addressStr = `${pack.kind === 'postfiliale' ? 'POSTFILIALE' : 'PACKSTATION'} ${pack.stationNumber}`;
    houseNumberStr = pack.stationNumber;
    console.log(`[createParcel] ${pack.kind} detected: postNumber="${toPostNumber}", station="${pack.stationNumber}"`);
  }

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

  // Packstation/Postfiliale need the recipient's DHL Postnummer. Fail fast with
  // an actionable message instead of an opaque SendCloud 400 (receiver_address).
  if (isPackstation && !toPostNumber) {
    throw new Error(
      'DHL Postnummer fehlt für diese Packstation/Postfiliale. Bitte im Auftrag unter ' +
      '„Kunde → Bearbeiten" die Postnummer des Empfängers eintragen und erneut versuchen.'
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

  if (isPackstation) {
    if (toPostNumber) parcelData.parcel.to_post_number = toPostNumber;
    // DHL Kleinpaket (2830) doesn't support Packstation — force DHL Paket (89)
    if (shippingMethodId === 2830) {
      console.log(`[createParcel] Packstation: switching DHL Kleinpaket (2830) → DHL Paket (89)`);
      shippingMethodId = 89;
    }
  }

  if (shippingMethodId) {
    parcelData.parcel.shipment = { id: shippingMethodId };
  }

  // Single-call label creation: Deutsche Post Internetmarke (carrier=dp) only
  // announces to the DP API during initial POST — a subsequent PUT re-announce
  // is rejected and leaves the parcel in "Announcement failed" state. We therefore
  // request the label in the same POST for ALL carriers. Failed carrier validation
  // does not incur label cost; SendCloud only charges on successful announcement.
  parcelData.parcel.request_label = requestLabel;

  console.log(`[createParcel] Payload for ${order.id}: postal_code="${zipStr}", country="${countryRaw}", city="${cityStr}", address="${addressStr}", house_number="${houseNumberStr}", name="${nameStr}", method=${shippingMethodId || 'default'}, request_label=${requestLabel}${toPostNumber ? `, to_post_number="${toPostNumber}"` : ''}`);

  // Try original, then address variants (no label cost on failure)
  let res;
  try {
    res = await _sendParcelRequest(parcelData, auth);
  } catch (err) {
    const isAddrErr = err.message.includes('receiver_address') || err.message.includes('Adresse konnte');
    if (!isAddrErr) throw err;

    // Try normalized German address variants (Straße→Str., Ortsteil removal, ß→ss)
    const variants = germanAddressVariants(parcelData.parcel.address);
    if (variants.length === 0) throw err;

    let resolved = false;
    for (const variant of variants) {
      console.warn(`[createParcel] Address rejected, trying variant: "${parcelData.parcel.address}" → "${variant}"`);
      parcelData.parcel.address = variant;
      try {
        res = await _sendParcelRequest(parcelData, auth);
        resolved = true;
        break;
      } catch (retryErr) {
        const stillAddrErr = retryErr.message.includes('receiver_address') || retryErr.message.includes('Adresse konnte');
        if (!stillAddrErr) throw retryErr;
        console.warn(`[createParcel] Variant "${variant}" also rejected`);
      }
    }
    if (!resolved) throw err;
  }

  const result = await res.json();
  let parcel = result?.parcel || {};
  const isA4 = labelFormat === 'a4';

  // Detect carrier-level rejection (status 1002 "Announcement failed") and surface
  // a clear error instead of persisting a useless parcel.
  const statusId = Number(parcel.status?.id || 0);
  if (statusId === 1002) {
    const statusMsg = parcel.status?.message || 'Announcement failed';
    const errMsgs = (parcel.errors && Object.values(parcel.errors).flat()).join('; ') || '';
    console.error(`[createParcel] Parcel ${parcel.id} status 1002: ${statusMsg}. Errors: ${errMsgs}`);
    try {
      await fetch(`${SENDCLOUD_BASE_URL}/parcels/${parcel.id}/cancel`, {
        method: 'POST', headers: { Authorization: auth },
      });
    } catch (_) {}
    throw new Error(`SendCloud Announcement failed${errMsgs ? `: ${errMsgs}` : ''}. Methode/Adresse/Guthaben prüfen.`);
  }

  // Extract label URL from response (falls back to constructed /labels/:printer/:id
  // endpoint for async carriers like DP Internetmarke — see extractLabelUrl).
  let labelUrl = extractLabelUrl(parcel, isA4);

  // If label URL not in immediate response, poll parcel API until label is ready.
  // BUG-FIX: tracking_number, tracking_url and carrier may also be empty on the
  // initial POST response (async carriers, high SendCloud load) and only populate
  // once polling succeeds. We therefore reassign `parcel` to the polled body and
  // re-derive ALL downstream fields from it — never from the initial response.
  if (requestLabel && !labelUrl && parcel.id) {
    console.log(`[createParcel] No label URL in POST response (parcel ${parcel.id}), polling...`);
    const polled = await pollForLabel({ parcelId: parcel.id, labelFormat, maxAttempts: 10, intervalMs: 2000 });
    if (polled.labelUrl) {
      labelUrl = polled.labelUrl;
      parcel = polled.parcel || parcel;
      console.log(`[createParcel] Label ready after polling (parcel ${parcel.id})`);
    } else {
      console.warn(`[createParcel] Label NOT generated by SendCloud after polling (parcel ${parcel.id}). Status: ${polled.status || 'unknown'}`);
    }
  }

  // Re-derive AFTER polling so async-populated fields (tracking_number for DPD,
  // tracking_url, final carrier code) end up in Firestore. This was the root cause
  // of "label exists in SendCloud but order shows no tracking" (incident 2026-04-29).
  const trackingNumber = parcel.tracking_number || null;
  const trackingUrl = parcel.tracking_url || null;
  const carrierCode = parcel.carrier?.code || null;

  // Save shipment record to Firestore
  const shipmentDoc = {
    tenantId,
    orderId: order.id || order.orderId || null,
    orderNumber: order.marketplaceOrderId || order.orderId || null,
    marketplaceOrderId: order.marketplaceOrderId || null,
    marketplace: order.marketplace || order.source || null,
    sendcloudParcelId: parcel.id || null,
    trackingNumber,
    trackingUrl,
    labelUrl,
    carrier: carrierCode,
    carrierName: carrierCode,
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
    trackingUrl,
    labelUrl,
    carrier: carrierCode,
  };
}

/**
 * Search SendCloud for parcels by `order_number`.
 *
 * Documented endpoint: GET /api/v2/parcels?order_number=...
 * (https://www.sendcloud.dev/docs/shipping/orders-via-api)
 *
 * Returns the raw parcel objects sorted newest-first by `date_created`.
 * Cancelled parcels (statusId=2000) are filtered out — we never want to
 * re-bind a Firestore shipment to a parcel that is already dead at carrier
 * level.
 *
 * Network/auth errors are swallowed — this is a best-effort recovery
 * helper. Returns [] on failure so the caller can fall back to whatever
 * data it already has.
 *
 * @param {{ orderNumber: string, auth: string }} opts
 * @returns {Promise<object[]>}
 */
async function _searchParcelsByOrderNumber({ orderNumber, auth }) {
  const trimmed = String(orderNumber || '').trim();
  if (!trimmed) return [];
  try {
    const url = `${SENDCLOUD_BASE_URL}/parcels?order_number=${encodeURIComponent(trimmed)}`;
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) {
      console.warn(`[refreshShipment] SendCloud search by order_number "${trimmed}" returned ${res.status}`);
      return [];
    }
    const data = await res.json();
    const parcels = Array.isArray(data?.parcels) ? data.parcels : [];
    return parcels
      .filter((p) => Number(p?.status?.id) !== 2000)
      .sort((a, b) => {
        // SendCloud returns dates as "DD-MM-YYYY HH:mm:ss" — compare via Date.parse fallback.
        const td = (raw) => {
          if (!raw) return 0;
          const t = Date.parse(raw);
          if (!Number.isNaN(t)) return t;
          // "16-07-2021 13:04:04" → "2021-07-16T13:04:04"
          const m = String(raw).match(/^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
          if (m) return Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}`);
          return 0;
        };
        return td(b.date_updated || b.date_created) - td(a.date_updated || a.date_created);
      });
  } catch (err) {
    console.warn(`[refreshShipment] SendCloud search by order_number "${trimmed}" failed: ${err.message}`);
    return [];
  }
}

/**
 * Re-pull the latest state of an order's most recent shipment from SendCloud
 * and reconcile both the `shipments` and `orders` Firestore docs with it.
 *
 * Self-heals two related incidents:
 *   • 2026-04-29 morning: tracking populated async after the initial create →
 *     never written back to Firestore (fixed in createParcel).
 *   • 2026-04-29 noon: stored sendcloudParcelId points at a stale/wrong
 *     parcel; the visible parcel in SendCloud has a different ID. Refresh
 *     by stored ID alone returns "no changes" → the bug surfaced as
 *     "Versand bereits aktuell — keine Änderungen von SendCloud."
 *
 * Recovery strategy:
 *   1. Load the parcel by stored sendcloudParcelId.
 *   2. If that parcel has no tracking_number AND no label, search SendCloud
 *      by `order_number` for alternates (incl. order.marketplaceOrderId,
 *      order.orderId, order.number — exactly the values createParcel writes
 *      into the `order_number` field).
 *   3. If a non-cancelled alternate exists with a tracking_number that is
 *      different from the stored ID, treat IT as the source of truth and
 *      re-bind shipment.sendcloudParcelId.
 *
 * Reconciliation is strictly additive — a non-empty SendCloud value never
 * gets overwritten by a later transient null response. Status-id transitions
 * are the only exception (ausstehend → in_zustellung → zugestellt).
 *
 * @param {{ orderId: string, tenantId?: string, labelFormat?: 'a6' | 'a4' }} opts
 * @returns {Promise<{
 *   shipmentId: string,
 *   sendcloudParcelId: number | null,
 *   previousSendcloudParcelId: number | null,
 *   reboundParcel: boolean,
 *   searchedAlternates: boolean,
 *   alternatesFound: number,
 *   trackingNumber: string | null,
 *   trackingUrl: string | null,
 *   carrier: string | null,
 *   labelUrl: string | null,
 *   status: string,
 *   parcelStatusMessage: string | null,
 *   updated: string[],
 * }>}
 */
async function refreshShipmentFromSendCloud({ orderId, tenantId = 'default', labelFormat = 'a6' }) {
  if (!orderId) throw new Error('orderId is required');
  const db = getDb();

  const snap = await db.collection(SHIPMENTS_COLLECTION)
    .where('orderId', '==', orderId)
    .limit(20)
    .get();

  if (snap.empty) {
    throw new Error('Kein Versanddatensatz für diesen Auftrag gefunden.');
  }

  const docs = snap.docs
    .map((d) => ({ id: d.id, ref: d.ref, data: d.data() }))
    .sort((a, b) => {
      const ta = Date.parse(a.data.createdAt || '') || 0;
      const tb = Date.parse(b.data.createdAt || '') || 0;
      return tb - ta;
    });

  // Prefer the newest non-cancelled shipment so we don't reconcile against a stale 'problem' record.
  const shipmentEntry = docs.find((d) => (d.data.status || '') !== 'cancelled') || docs[0];
  const shipment = shipmentEntry.data;
  const initialParcelId = Number(shipment.sendcloudParcelId || 0);

  if (!initialParcelId) {
    throw new Error('Versanddatensatz hat keine SendCloud-Parcel-ID. Manuelle Korrektur nötig.');
  }

  const auth = await getSendCloudAuth();
  const isA4 = labelFormat === 'a4';

  // ── 1. Load the parcel pointed at by the stored ID ────────────────────────
  let parcel;
  try {
    const res = await fetch(`${SENDCLOUD_BASE_URL}/parcels/${initialParcelId}`, {
      headers: { Authorization: auth },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`SendCloud Parcel ${initialParcelId} konnte nicht geladen werden (${res.status}): ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    parcel = json?.parcel || {};
  } catch (err) {
    // Don't bail yet — the alternate search below may still find a working parcel.
    console.warn(`[refreshShipment] direct fetch of parcel ${initialParcelId} failed: ${err.message}`);
    parcel = { id: initialParcelId };
  }

  let usedParcelId = Number(parcel?.id || initialParcelId);
  let reboundParcel = false;

  // ── 2. Fallback: search by order_number when the stored parcel is incomplete ──
  const orderRef = db.collection(ORDERS_COLLECTION).doc(orderId);
  const orderSnap = await orderRef.get();
  const orderData = orderSnap.exists ? orderSnap.data() : null;

  const lacksTracking = !parcel?.tracking_number;
  const lacksLabel = !extractLabelUrl(parcel, isA4) || (parcel?.label && Object.keys(parcel.label).length === 0);
  let searchedAlternates = false;
  let alternatesFound = 0;

  if (lacksTracking || lacksLabel) {
    // Try every value `createParcel` may have written into SendCloud's order_number.
    const candidates = [];
    const pushCand = (v) => {
      const s = v == null ? '' : String(v).trim();
      if (s && !candidates.includes(s)) candidates.push(s);
    };
    if (orderData) {
      pushCand(orderData.marketplaceOrderId);
      pushCand(orderData.orderId);
      pushCand(orderData.number);
    }
    pushCand(orderId);

    for (const candidate of candidates) {
      const matches = await _searchParcelsByOrderNumber({ orderNumber: candidate, auth });
      searchedAlternates = true;
      if (!matches.length) continue;
      alternatesFound += matches.length;

      // Best alternate: prefer ones with tracking_number; among those, the most
      // recently-updated. Skip the parcel we already have unless it's the only match.
      const withTracking = matches.filter((p) => p?.tracking_number);
      const candidateList = withTracking.length ? withTracking : matches;
      const best = candidateList[0];
      if (!best) continue;

      const bestId = Number(best.id || 0);
      // Only re-bind when we found a strictly better source (different id AND has tracking,
      // OR same id but the GET-by-id call failed and the search returned the full body).
      if (bestId && (bestId !== initialParcelId || (lacksTracking && best.tracking_number))) {
        parcel = best;
        usedParcelId = bestId;
        reboundParcel = bestId !== initialParcelId;
        break;
      }
    }
  }

  // ── 3. Derive freshest values from whichever parcel we ended up with ──────
  const freshLabelUrl = extractLabelUrl(parcel, isA4);
  const freshTracking = parcel?.tracking_number || null;
  const freshTrackingUrl = parcel?.tracking_url || null;
  const freshCarrier = parcel?.carrier?.code || null;
  const freshStatus = mapSendCloudStatus(parcel?.status?.id);
  const freshStatusId = parcel?.status?.id || null;
  const freshStatusMsg = parcel?.status?.message || null;
  const nowIso = new Date().toISOString();

  // Build a strictly-additive shipment patch — never null out an existing value.
  const shipmentPatch = { updatedAt: nowIso };
  const updated = [];
  const setIfBetter = (field, current, next) => {
    if (next != null && next !== '' && next !== current) {
      shipmentPatch[field] = next;
      updated.push(`shipment.${field}`);
    }
  };
  // Re-link the shipment to the correct SendCloud parcel BEFORE writing other fields,
  // so the rest of the patch is consistent with the parcel id we now claim ownership of.
  if (reboundParcel) {
    shipmentPatch.sendcloudParcelId = usedParcelId;
    updated.push('shipment.sendcloudParcelId');
  }
  setIfBetter('trackingNumber', shipment.trackingNumber, freshTracking);
  setIfBetter('trackingUrl',    shipment.trackingUrl,    freshTrackingUrl);
  setIfBetter('labelUrl',       shipment.labelUrl,       freshLabelUrl);
  setIfBetter('carrier',        shipment.carrier,        freshCarrier);
  setIfBetter('carrierName',    shipment.carrierName,    freshCarrier);
  // Status MAY transition (ausstehend → in_zustellung → zugestellt) — overwrite blindly.
  if (freshStatus && freshStatus !== shipment.status) {
    shipmentPatch.status = freshStatus;
    updated.push('shipment.status');
  }
  if (freshStatusId && Number(freshStatusId) !== Number(shipment.statusId || 0)) {
    shipmentPatch.statusId = freshStatusId;
    updated.push('shipment.statusId');
  }
  if (freshStatusMsg && freshStatusMsg !== shipment.statusRaw) {
    shipmentPatch.statusRaw = freshStatusMsg;
    updated.push('shipment.statusRaw');
  }

  if (Object.keys(shipmentPatch).length > 1) {
    await shipmentEntry.ref.set(shipmentPatch, { merge: true });
  }

  // Mirror the reconciled fields to the order so the UI can show tracking + the
  // print button without a second sync. Same additive policy.
  if (orderData) {
    const orderPatch = { updatedAt: nowIso };
    if (freshTracking && freshTracking !== orderData.trackingNumber) {
      orderPatch.trackingNumber = freshTracking;
      updated.push('order.trackingNumber');
    }
    if (freshTrackingUrl && freshTrackingUrl !== orderData.trackingUrl) {
      orderPatch.trackingUrl = freshTrackingUrl;
      updated.push('order.trackingUrl');
    }
    if (freshCarrier && freshCarrier !== orderData.shippingService) {
      orderPatch.shippingService = freshCarrier;
      updated.push('order.shippingService');
    }
    if (!orderData.shipmentId && shipmentEntry.id) {
      orderPatch.shipmentId = shipmentEntry.id;
      updated.push('order.shipmentId');
    }
    if (Object.keys(orderPatch).length > 1) {
      await orderRef.set(orderPatch, { merge: true });
    }
  }

  return {
    shipmentId: shipmentEntry.id,
    sendcloudParcelId: usedParcelId || null,
    previousSendcloudParcelId: reboundParcel ? initialParcelId : null,
    reboundParcel,
    searchedAlternates,
    alternatesFound,
    trackingNumber: freshTracking || shipment.trackingNumber || null,
    trackingUrl: freshTrackingUrl || shipment.trackingUrl || null,
    carrier: freshCarrier || shipment.carrier || null,
    labelUrl: freshLabelUrl || shipment.labelUrl || null,
    status: freshStatus || shipment.status || 'unknown',
    parcelStatusMessage: freshStatusMsg || shipment.statusRaw || null,
    updated,
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
 * Sort rules by user-defined `order` (ascending) when present, falling back to
 * `maxWeight` ascending so the smallest matching rule wins for legacy data.
 * `order` is set by the drag-and-drop UI in OrderSettingsView.
 *
 * @param {object[]} rules
 * @returns {object[]} new sorted array
 */
function _sortCarrierRules(rules) {
  return [...rules].sort((a, b) => {
    const aHasOrder = a && a.order != null && Number.isFinite(Number(a.order));
    const bHasOrder = b && b.order != null && Number.isFinite(Number(b.order));
    if (aHasOrder && bHasOrder) return Number(a.order) - Number(b.order);
    if (aHasOrder) return -1;
    if (bHasOrder) return 1;
    return (Number(a.maxWeight) || 0) - (Number(b.maxWeight) || 0);
  });
}

/**
 * Return ALL carrier rules whose [minWeight, maxWeight] range contains `weight`.
 * Used by the shipping-preview endpoint to surface multiple valid choices
 * to the user when overlapping rules are configured (e.g. DHL Kleinpaket
 * AND DP Maxibrief both cover 1 kg).
 *
 * Sorted by user-defined `order` first (drag-and-drop in OrderSettingsView),
 * falling back to `maxWeight` ascending.
 *
 * @param {{ weight: number, rules: object[] }} opts
 * @returns {Array<{ shippingMethodId: number, carrier: string, label: string,
 *                   minWeight: number, maxWeight: number, order?: number, id?: string }>}
 */
function matchAllCarrierRules({ weight, rules }) {
  if (!Array.isArray(rules) || rules.length === 0) return [];
  const w = Number(weight);
  if (!Number.isFinite(w)) return [];

  const sorted = _sortCarrierRules(rules);
  const matches = [];
  for (const rule of sorted) {
    const min = Number(rule.minWeight) || 0;
    const max = Number(rule.maxWeight) || Infinity;
    if (w >= min && w <= max) {
      matches.push({
        id: rule.id || null,
        shippingMethodId: Number(rule.shippingMethodId) || 0,
        carrier: rule.carrier || 'unknown',
        label: rule.label || rule.carrier || 'Standard',
        minWeight: min,
        maxWeight: Number.isFinite(max) ? max : null,
        order: rule.order != null ? Number(rule.order) : null,
      });
    }
  }
  return matches;
}

/**
 * Match shipping method based on carrier rules from order_settings.
 *
 * Rules format:
 *   { minWeight?: number, maxWeight: number, shippingMethodId: number, carrier: string, label: string, order?: number }
 *
 * Example rules:
 *   { minWeight: 0.5, maxWeight: 1.99, shippingMethodId: 89, carrier: 'dhl', label: 'DHL Kleinpaket' }
 *   { minWeight: 2,   maxWeight: 4.99, shippingMethodId: 201, carrier: 'dpd', label: 'DPD Classic 0-5 kg' }
 *
 * Selection precedence:
 *   1. Highest-priority rule (lowest `order`) whose range contains `weight`.
 *   2. Smallest-`maxWeight` rule whose range contains `weight` (legacy data without `order`).
 *   3. Largest rule when `weight` exceeds every range (overflow fallback).
 *
 * @param {{ weight: number, rules: object[] }} opts
 * @returns {{ shippingMethodId: number, carrier: string, label: string } | null}
 */
function matchCarrierRule({ weight, rules }) {
  if (!Array.isArray(rules) || rules.length === 0) return null;

  const w = Number(weight) || 0;
  const sorted = _sortCarrierRules(rules);

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

  // Fallback: if weight exceeds all rules, use the rule with the largest maxWeight.
  // We deliberately ignore user-defined `order` here so the fallback still picks
  // the physically largest carrier instead of an arbitrary high-priority one.
  const byMax = [...rules].sort((a, b) => (Number(a.maxWeight) || 0) - (Number(b.maxWeight) || 0));
  const last = byMax[byMax.length - 1];
  if (last && w > (Number(last.maxWeight) || 0)) {
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

  // Guard: check if a shipment already exists for this order to prevent duplicate SendCloud parcels.
  // Fetch by orderId only (auto single-field index) and filter in-memory to avoid
  // requiring a composite (orderId, status) index for the != inequality.
  // Only statuses that represent a live, usable shipment block a retry.
  // 'problem' (SendCloud 1002 Announcement failed) and 'cancelled' are dead — the
  // parcel is unusable and the user must be allowed to re-ship. Old 'problem' records
  // stay as historical state; we mark them 'cancelled' so the guard is clean next time.
  const BLOCKING_STATUSES = new Set(['ausstehend', 'in_zustellung', 'zugestellt']);
  const shipmentSnap = await db.collection(SHIPMENTS_COLLECTION)
    .where('orderId', '==', orderId)
    .limit(10)
    .get();
  const activeShipment = shipmentSnap.docs.find((doc) => BLOCKING_STATUSES.has(doc.data().status || ''));
  if (activeShipment) {
    const existing = activeShipment.data();
    console.warn(`[shipOrder] Order ${orderId} already has active shipment ${activeShipment.id} (status=${existing.status}, tracking=${existing.trackingNumber}). Skipping duplicate.`);
    return {
      trackingNumber: existing.trackingNumber || null,
      trackingUrl: existing.trackingUrl || null,
      carrier: existing.carrier || null,
      shipmentId: activeShipment.id,
      labelUrl: existing.labelUrl || null,
      duplicate: true,
    };
  }

  // Retire any stale 'problem' shipments for this order so the Firestore state
  // reflects reality (the SendCloud parcels behind them are 404/cancelled).
  const staleProblem = shipmentSnap.docs.filter((doc) => (doc.data().status || '') === 'problem');
  for (const doc of staleProblem) {
    await doc.ref.set({
      status: 'cancelled',
      statusRaw: `auto-retired: ${doc.data().statusRaw || 'problem'}`,
      updatedAt: new Date().toISOString(),
    }, { merge: true }).catch((err) => console.warn(`[shipOrder] Could not retire stale shipment ${doc.id}: ${err.message}`));
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

    // Auto-transition to shipped if tracking is confirmed and order is NOT already in a terminal state
    const currentStatus = order.omsStatus || order.status || 'pending';
    if (trackingNumber && !['shipped', 'delivered', 'completed', 'cancelled', 'returned'].includes(currentStatus)) {
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

const SHIPPING_METHODS_COLLECTION = 'shipping_methods';

/**
 * Sync SendCloud shipping methods into Firestore.
 * Uses a 1-hour stale check to avoid unnecessary API calls.
 *
 * @param {string} tenantId
 * @returns {Promise<object[]>} enabled shipping methods
 */
async function syncShippingMethods(tenantId = 'default', { force = false } = {}) {
  const db = getDb();

  // Stale check: if newest doc was synced less than 1 hour ago, return cached
  // Skip stale check when force=true (manual sync from UI)
  if (!force) {
    const recentSnap = await db.collection(SHIPPING_METHODS_COLLECTION)
      .where('tenantId', '==', tenantId)
      .orderBy('lastSyncedAt', 'desc')
      .limit(1)
      .get();

    if (!recentSnap.empty) {
      const lastSync = recentSnap.docs[0].data().lastSyncedAt;
      if (lastSync) {
        const age = Date.now() - new Date(lastSync).getTime();
        if (age < 60 * 60 * 1000) {
          // Return cached methods
          const cachedSnap = await db.collection(SHIPPING_METHODS_COLLECTION)
            .where('tenantId', '==', tenantId)
            .where('enabled', '==', true)
            .get();
          return cachedSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        }
      }
    }
  }

  // Fetch from SendCloud API
  const apiMethods = await getShippingMethods();
  const now = new Date().toISOString();

  // Track which SendCloud IDs are still active
  const activeIds = new Set();

  // Batch write: upsert each method
  const batch = db.batch();
  for (const m of apiMethods) {
    const docId = `${tenantId}_${m.id}`;
    activeIds.add(docId);
    const ref = db.collection(SHIPPING_METHODS_COLLECTION).doc(docId);
    batch.set(ref, {
      tenantId,
      sendcloudId: m.id,
      carrier: (m.carrier || '').toLowerCase(),
      carrierName: m.carrier || '',
      name: m.name || '',
      minWeight: m.min_weight != null ? Number(m.min_weight) : 0,
      maxWeight: m.max_weight != null ? Number(m.max_weight) : 0,
      countries: Array.isArray(m.countries) ? m.countries.map(c => c.iso_2 || c) : [],
      servicePointInput: m.service_point_input || 'none',
      enabled: true,
      lastSyncedAt: now,
    }, { merge: true });
  }
  await batch.commit();

  // Mark methods not in API response as disabled
  const allSnap = await db.collection(SHIPPING_METHODS_COLLECTION)
    .where('tenantId', '==', tenantId)
    .get();

  const disableBatch = db.batch();
  let disableCount = 0;
  for (const doc of allSnap.docs) {
    if (!activeIds.has(doc.id) && doc.data().enabled !== false) {
      disableBatch.update(doc.ref, { enabled: false, lastSyncedAt: now });
      disableCount++;
    }
  }
  if (disableCount > 0) await disableBatch.commit();

  // Return fresh list
  const freshSnap = await db.collection(SHIPPING_METHODS_COLLECTION)
    .where('tenantId', '==', tenantId)
    .where('enabled', '==', true)
    .get();
  return freshSnap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Get cached shipping methods from Firestore with optional filtering.
 * Triggers initial sync if collection is empty.
 *
 * @param {string} tenantId
 * @param {{ weight?: number, country?: string }} opts
 * @returns {Promise<object[]>}
 */
async function getCachedShippingMethods(tenantId = 'default', { weight, country } = {}) {
  const db = getDb();
  let query = db.collection(SHIPPING_METHODS_COLLECTION)
    .where('tenantId', '==', tenantId)
    .where('enabled', '==', true);

  const snap = await query.get();
  let methods = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // If collection is empty, trigger initial sync
  if (methods.length === 0) {
    methods = await syncShippingMethods(tenantId);
  }

  // Filter by weight if provided
  if (weight != null) {
    const w = Number(weight);
    methods = methods.filter(m => w >= (m.minWeight || 0) && w <= (m.maxWeight || Infinity));
  }

  // Filter by country if provided
  if (country) {
    const c = country.toUpperCase();
    methods = methods.filter(m => !m.countries?.length || m.countries.includes(c));
  }

  // Sort by carrier, then name
  methods.sort((a, b) => (a.carrier || '').localeCompare(b.carrier || '') || (a.name || '').localeCompare(b.name || ''));

  return methods;
}

// ─── Delivery Status Polling ──────────────────────────────────────────────────

const DELIVERED_STATUS_IDS = new Set([11, 12, 62]);

/**
 * Poll SendCloud for delivery status of all shipped orders.
 * Transitions orders from shipped → delivered when carrier confirms delivery.
 *
 * @param {{ tenantId?: string }} opts
 * @returns {Promise<{ checked: number, delivered: number, errors: number }>}
 */
async function pollDeliveryStatus({ tenantId = 'default' } = {}) {
  const db = getDb();
  let checked = 0, delivered = 0, errors = 0;

  // Find all shipped orders that have a shipmentId
  const ordersSnap = await db.collection(ORDERS_COLLECTION)
    .where('omsStatus', '==', 'shipped')
    .where('tenantId', '==', tenantId)
    .get();

  if (ordersSnap.empty) {
    return { checked: 0, delivered: 0, errors: 0 };
  }

  let authHeader;
  try {
    authHeader = await getSendCloudAuth();
  } catch (err) {
    console.warn('[delivery-poll] SendCloud auth failed:', err.message);
    return { checked: 0, delivered: 0, errors: 1 };
  }

  for (const orderDoc of ordersSnap.docs) {
    const order = orderDoc.data();
    const shipmentId = order.shipmentId;
    if (!shipmentId) continue;

    try {
      const shipSnap = await db.collection(SHIPMENTS_COLLECTION).doc(shipmentId).get();
      if (!shipSnap.exists) continue;

      const shipData = shipSnap.data();
      const parcelId = shipData.sendcloudParcelId;
      if (!parcelId) continue;

      checked++;

      // Call SendCloud API
      const res = await fetch(`${SENDCLOUD_BASE_URL}/parcels/${parcelId}`, {
        headers: { Authorization: authHeader },
      });

      if (!res.ok) {
        if (res.status === 404) continue; // Parcel not found, skip
        console.warn(`[delivery-poll] SendCloud API ${res.status} for parcel ${parcelId}`);
        errors++;
        continue;
      }

      const json = await res.json();
      const statusId = Number(json?.parcel?.status?.id || 0);
      const statusMessage = json?.parcel?.status?.message || '';

      if (!DELIVERED_STATUS_IDS.has(statusId)) continue;

      // Parcel is delivered — update shipment
      const now = new Date().toISOString();
      await shipSnap.ref.set({
        status: statusMessage,
        statusId,
        deliveredAt: now,
        updatedAt: now,
      }, { merge: true });

      // HARDEN-Wave-2 (2026-05-22): nutze state-machine statt direct-set,
      // damit alle Status-Übergänge denselben Pfad nehmen (Event-Log,
      // Side-Effects, future hooks). Vorher: direct orderRef.set →
      // `order:status_changed` Event wurde nie emittiert, Sync-Cascade
      // (tracking-backfill, marketplace push) lief nicht.
      try {
        const { transitionOrder } = require('./order-state-machine');
        await transitionOrder({
          tenantId,
          orderId: orderDoc.id,
          toStatus: 'delivered',
          force: true,
          actor: { uid: 'system', email: 'delivery-poll' },
          note: `SendCloud: ${statusMessage} (parcel ${parcelId})`,
          timestamps: { deliveredAt: now },
        });
        // Fan-out via sync-bus damit downstream listeners (z.B. marketplace
        // status push, KPI refresh) reagieren können.
        try {
          const { emitSyncEvent } = require('./sync-event-bus');
          emitSyncEvent('order:status_changed', {
            entityId: orderDoc.id,
            tenantId,
            fromStatus: 'shipped',
            toStatus: 'delivered',
            source: 'delivery-poll',
          });
        } catch (_) {
          // sync-bus error must never block the poll
        }
      } catch (txErr) {
        // Falls transitionOrder fehlschlägt (z.B. invalid transition):
        // direct-set als Notfall-Fallback + Audit-Log, damit der Status
        // wenigstens visuell stimmt. NICHT silent — wir loggen den Fall.
        console.warn(`[delivery-poll] transitionOrder failed for ${orderDoc.id}: ${txErr.message} — fallback direct set`);
        const { ORDER_STATUSES } = require('./order-state-machine');
        await orderDoc.ref.set({
          omsStatus: 'delivered',
          omsStatusLabel: ORDER_STATUSES?.delivered?.label || 'Zugestellt',
          deliveredAt: now,
          updatedAt: now,
        }, { merge: true });
        await db.collection('order_events').add({
          orderId: orderDoc.id,
          tenantId,
          event: 'status_change_fallback',
          fromStatus: 'shipped',
          toStatus: 'delivered',
          actor: { uid: 'system', email: 'delivery-poll' },
          note: `Fallback direct-set (transitionOrder failed: ${txErr.message})`,
          timestamp: FieldValue.serverTimestamp(),
        });
      }

      delivered++;
      console.log(`[delivery-poll] Order ${orderDoc.id}: shipped → delivered (parcel ${parcelId})`);
    } catch (err) {
      console.warn(`[delivery-poll] Error checking order ${orderDoc.id}: ${err.message}`);
      errors++;
    }

    // Rate limit: 200ms between API calls
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`[delivery-poll] Done: checked=${checked} delivered=${delivered} errors=${errors}`);
  return { checked, delivered, errors };
}

module.exports = {
  getShippingMethods,
  syncShippingMethods,
  getCachedShippingMethods,
  createParcel,
  getLabel,
  cancelParcel,
  calculateOrderWeight,
  matchCarrierRule,
  matchAllCarrierRules,
  shipOrder,
  refreshShipmentFromSendCloud,
  downloadLabelPdf,
  syncSendCloudParcels,
  pollDeliveryStatus,
  DEFAULT_CARRIER_RULES,
};
