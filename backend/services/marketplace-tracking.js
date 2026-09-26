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
 * Max number of tracking-push attempts before a failure is abandoned.
 * Without a cap, a permanently-rejected push (e.g. Kaufland "Validation Failed")
 * loops forever across the in-memory timer + ensure + catch-up triggers — the
 * 2026-06-12 sync-storm that hammered the marketplace APIs + Firestore.
 */
const MAX_PUSH_ATTEMPTS = 6;

/** eBay/Kaufland API rate-limit signature — transient, retry LATER (not immediately). */
function isRateLimitedError(msg) {
  const m = String(msg || '').toLowerCase();
  return (
    m.includes('exceeded usage limit') ||
    m.includes('check your call usage') ||
    m.includes('too many requests') ||
    m.includes('rate limit') ||
    m.includes('429')
  );
}

/**
 * Kaufland-Unit-Fehler, der bedeutet: die Ziel-Aktion ist schon passiert
 * (Unit bereits 'sent' bzw. 'cancelled'). Zaehlt beim Retry als Erfolg,
 * damit ein Teilfehler-Retry idempotent konvergiert statt an den bereits
 * erledigten Units erneut zu scheitern.
 *
 * @param {string} msg — Fehlermeldung der Kaufland-API
 * @param {'sent'|'cancelled'} targetState
 */
function isKauflandUnitAlreadyDone(msg, targetState) {
  const m = String(msg || '').toLowerCase();
  // Bewusst eng: nur "already …" bzw. "is in status '<target>'" zaehlt.
  // Ein "transition to <target> not allowed" bedeutet das GEGENTEIL
  // (Unit ist in einem anderen Status) und muss ein Fehler bleiben.
  if (m.includes('not allowed') || m.includes('forbidden')) return false;
  if (targetState === 'sent') {
    return /already.*(sent|shipped|send)|is (already )?in status ['"]?sent['"]?/.test(m);
  }
  if (targetState === 'cancelled') {
    return /already.*cancel|is (already )?in status ['"]?cancell?ed['"]?/.test(m);
  }
  return false;
}

/** Errors that will NEVER succeed on retry — abandon immediately instead of looping. */
function isPermanentPushError(msg) {
  const m = String(msg || '').toLowerCase();
  return (
    m.includes('validation failed') ||
    m.includes('no ebay order id') ||
    m.includes('order not found') ||
    m.includes('already shipped') ||
    m.includes('already acknowledged') ||
    m.includes('invalid order') ||
    m.includes('order cancelled on ebay')
  );
}

/**
 * Decide the marketplacePush status + attempt count for a push result.
 * Pure + exported so the retry-cap behavior is unit-tested without Firestore.
 *
 * Kontingent-Fehler zaehlen NICHT gegen die Obergrenze (seit 2026-09-26):
 * das eBay-Tageskontingent ist regelmaessig von ~00:30 bis 07:00 UTC leer.
 * Zaehlte jeder Nachholversuch in dieser Zeit mit, waere der Push nach einer
 * Stunde 'abandoned' — fuer immer, obwohl er am Morgen problemlos durchginge.
 * Der Push selbst ist daran nicht schuld; gegen einen Sturm schuetzt der
 * Kontingent-Schutzschalter in lib/ebay-trading-api.js (der Aufruf verlaesst
 * den Prozess gar nicht) und die Altersgrenze im Nachholer.
 *
 * @param {{ ok: boolean, error?: string, prevAttempts?: number }} opts
 * @returns {{ status: 'success'|'failed'|'abandoned', attempts: number, rateLimited: boolean, permanent: boolean }}
 */
function deriveMarketplacePushStatus({ ok, error, prevAttempts = 0 }) {
  const base = Number(prevAttempts) || 0;
  if (ok) return { status: 'success', attempts: base, rateLimited: false, permanent: false };
  const permanent = isPermanentPushError(error);
  const rateLimited = !permanent && isRateLimitedError(error);
  if (rateLimited) return { status: 'failed', attempts: base, rateLimited, permanent };
  const attempts = base + 1;
  const status = permanent || attempts >= MAX_PUSH_ATTEMPTS ? 'abandoned' : 'failed';
  return { status, attempts, rateLimited, permanent };
}

/**
 * Persist the marketplacePush status with a short retry. A transient Firestore
 * blip must NOT lose a 'success' marker — otherwise every later trigger re-reads
 * the order as "not pushed" and re-pushes forever (the infinite-loop trap).
 */
async function saveMarketplacePushStatus(ref, marketplacePush, orderId) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await ref.set({ marketplacePush }, { merge: true });
      return true;
    } catch (err) {
      if (attempt === 3) {
        console.warn(`[marketplace-tracking] Failed to save push status for ${orderId}: ${err.message}`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  return false;
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

  // Decide status + attempt count (capped) and persist durably for retry/audit.
  const prevAttempts = Number(order.marketplacePush?.attempts) || 0;
  const { status, attempts, rateLimited, permanent } = deriveMarketplacePushStatus({
    ok: result.ok,
    error: result.error,
    prevAttempts,
  });

  await saveMarketplacePushStatus(orderSnap.ref, {
    status,
    marketplace,
    attempts,
    lastAttempt: new Date().toISOString(),
    error: result.ok ? null : (result.error || 'unknown'),
    trackingNumber,
    carrier: carrier || null,
    // Welcher eBay-Weg die Meldung getragen hat ('trading' = CompleteSale,
    // 'fulfillment_api' = REST-Ausweichweg bei leerem Trading-Kontingent).
    via: result.via || null,
  }, orderId);

  if (status === 'abandoned') {
    console.warn(`[marketplace-tracking] ABANDONED push for ${orderId} after ${attempts} attempt(s)${permanent ? ' (permanent error)' : ''}: ${result.error || ''}`);
    collectError({ type: 'api_error', severity: 'warning', channel: marketplace || 'internal', message: `Tracking-Push aufgegeben nach ${attempts} Versuch(en): ${result.error || 'unknown'}`, entityType: 'order', entityId: orderId, source: 'marketplace-tracking' });
  }

  // Schedule ONE in-memory 5-min retry ONLY for transient, non-rate-limited
  // failures still under the cap. Rate-limited failures wait for the
  // tracking-catchup cron — retrying immediately just burns more quota and
  // hammers Firestore (the 2026-06-12 sync-storm). 'abandoned'/'success' never
  // reschedule, which is what breaks the infinite loop.
  if (status === 'failed' && !rateLimited && marketplace) {
    const RETRY_DELAY_MS = 5 * 60 * 1000;
    setTimeout(() => {
      console.log(`[marketplace-tracking] Auto-retry push for ${orderId} after failure (next attempt ${attempts + 1}/${MAX_PUSH_ATTEMPTS})`);
      pushTrackingToMarketplace({ orderId, trackingNumber, carrier })
        .catch((err) => console.warn(`[marketplace-tracking] Auto-retry failed for ${orderId}: ${err.message}`));
    }, RETRY_DELAY_MS);
  }

  return result;
}

/**
 * Push tracking to eBay via CompleteSale (Trading API). Ist das
 * Trading-Tageskontingent leer, geht die Meldung ueber die
 * Sell-Fulfillment-REST-API (eigenes Kontingent).
 *
 * @param {{ order: object, trackingNumber: string, carrier: string }} opts
 * @returns {Promise<{ ok: boolean, marketplace: string, via?: string, error?: string }>}
 */
async function pushTrackingToEbay({ order, trackingNumber, carrier }) {
  const ebayOrderId = order.marketplaceOrderId || order.externalOrderId;
  if (!ebayOrderId) return { ok: false, marketplace: 'ebay', error: 'No eBay order ID' };

  const trading = await pushTrackingToEbayTrading({ order, ebayOrderId, trackingNumber, carrier });
  if (trading.ok || !isRateLimitedError(trading.error) || !ebayRestFallbackEnabled()) return trading;

  // Trading-Tageskontingent leer (gemessen: 5.000 Aufrufe/Tag fuer ALLE
  // Trading-Aufrufe zusammen, Reset 07:00 UTC; GetOrders allein verbrauchte
  // 72 %). Die Sell-Fulfillment-REST-API hat ein EIGENES Kontingent
  // (100.000/Tag) — der Versand wird also trotzdem sofort gemeldet, statt
  // bis zum naechsten Morgen zu warten.
  console.warn(`[marketplace-tracking] eBay Trading-Kontingent leer fuer ${ebayOrderId} — melde ueber Fulfillment-API`);
  const rest = await pushTrackingToEbayRest({ order, ebayOrderId, trackingNumber, carrier });
  if (rest.ok) return rest;
  // Beide Wege gescheitert: die Kontingent-Signatur der Trading-Antwort
  // behalten, damit der Nachholer den Versuch nicht gegen die Obergrenze zaehlt.
  return { ok: false, marketplace: 'ebay', via: 'fulfillment_api', error: `${trading.error} | Fulfillment-API: ${rest.error}` };
}

/** Notbremse fuer den REST-Ausweichweg — nur exakt 'off' schaltet ab. */
function ebayRestFallbackEnabled() {
  return String(process.env.EBAY_TRACKING_REST_FALLBACK || '').trim().toLowerCase() !== 'off';
}

async function pushTrackingToEbayTrading({ order, ebayOrderId, trackingNumber, carrier }) {
  try {
    const { callTradingApi, buildRequestRoot, getEbayTradingConfig } = require('../lib/ebay-trading-api');

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
    const ack = String(result?.ack || '').toLowerCase();
    console.log(`[marketplace-tracking] eBay CompleteSale for order ${ebayOrderId}: Ack=${result.ack}`);

    // eBay can answer HTTP 200 with a body-level Ack='Failure' WITHOUT callTradingApi
    // throwing. Treating that as success silently loses the tracking number forever
    // (never retried). Surface it as ok:false so the cap/retry/abandon logic runs.
    // Ack='Warning' means eBay accepted it (success) but flagged something — log it.
    if (ack === 'failure') {
      const errs = Array.isArray(result?.errors) ? result.errors : [];
      const message =
        errs[0]?.longMessage ||
        errs[0]?.shortMessage ||
        `CompleteSale failed with Ack=${result.ack || 'Failure'}`;
      console.error(`[marketplace-tracking] eBay CompleteSale Ack=Failure for order ${ebayOrderId}: ${message}`);
      collectError({ type: 'api_error', severity: 'warning', channel: 'ebay', message: `Tracking-Push eBay abgelehnt (Ack=Failure): ${message}`, entityType: 'order', entityId: ebayOrderId, source: 'marketplace-tracking' });
      return { ok: false, marketplace: 'ebay', via: 'trading', error: message };
    }

    if (ack === 'warning') {
      const errs = Array.isArray(result?.errors) ? result.errors : [];
      const warnMsg = errs[0]?.longMessage || errs[0]?.shortMessage || 'unspecified warning';
      console.warn(`[marketplace-tracking] eBay CompleteSale Ack=Warning for order ${ebayOrderId} (accepted): ${warnMsg}`);
    }

    return { ok: true, marketplace: 'ebay', via: 'trading' };
  } catch (err) {
    console.error(`[marketplace-tracking] eBay push failed: ${err.message}`);
    collectError({ type: 'api_error', severity: 'warning', channel: 'ebay', message: `Tracking-Push eBay fehlgeschlagen: ${err.message}`, entityType: 'order', entityId: order.marketplaceOrderId || order.externalOrderId, source: 'marketplace-tracking' });
    return { ok: false, marketplace: 'ebay', via: 'trading', error: err.message };
  }
}

/**
 * eBay-Versanddienstleister-Codes fuer die Fulfillment-REST-API. Anders als
 * CompleteSale (dort loest eBay auch 'dhl_de' oder 'dp' selbst auf — gemessen:
 * 'dhl_de' → "DHL Germany", 'dp' → "Deutsche Post (DHL)") verlangt
 * shippingCarrierCode einen Wert der eBay-Liste. Quelle: GeteBayDetails
 * ShippingCarrierDetails, Site 77, abgerufen 2026-09-26.
 */
const EBAY_REST_CARRIER_CODES = {
  dhl: 'DHL',
  dhl_de: 'DHL',
  'dhl-de': 'DHL',
  dhlde: 'DHL',
  dp: 'DeutschePost',
  deutsche_post: 'DeutschePost',
  deutschepost: 'DeutschePost',
  dpd: 'DPD',
  dpd_de: 'DPD',
  'dpd-de': 'DPD',
  gls: 'GLS',
  gls_de: 'GLS',
  hermes: 'Hermes',
  hermes_de: 'Hermes',
  ups: 'UPS',
  dhl_express: 'DHLEXPRESS',
  dhlexpress: 'DHLEXPRESS',
};

/**
 * Interne Transporteur-Kennung → eBay-Code fuer die REST-API, oder null.
 * Nur der Teil vor dem ':' zaehlt ('dpd:express/delivery=18' → dpd).
 * null heisst: nicht sicher zuzuordnen — dann lieber NICHT ueber REST melden
 * (ein falscher Code macht die Sendungsverfolgung fuer den Kaeufer wertlos).
 */
function toEbayRestCarrierCode(carrier) {
  const key = String(carrier || '').trim().toLowerCase().split(':')[0].replace(/\s+/g, '_');
  if (!key) return null;
  return EBAY_REST_CARRIER_CODES[key] || null;
}

/**
 * Versanddatum fuer die REST-Meldung: der ECHTE Versandzeitpunkt des Auftrags,
 * nicht der Zeitpunkt, zu dem der Nachholer endlich durchkam. Ungueltig oder
 * in der Zukunft → jetzt.
 */
function resolveShippedDate(order, nowMs = Date.now()) {
  const raw = order?.shippedAt;
  const ms = raw && typeof raw.toDate === 'function' ? raw.toDate().getTime() : Date.parse(raw || '');
  if (!Number.isFinite(ms) || ms > nowMs) return new Date(nowMs).toISOString();
  return new Date(ms).toISOString();
}

async function readRestError(res) {
  const text = await res.text().catch(() => '');
  try {
    const json = JSON.parse(text);
    const first = Array.isArray(json?.errors) ? json.errors[0] : null;
    if (first) return `${first.errorId || ''} ${first.longMessage || first.message || ''}`.trim();
  } catch (_) { /* kein JSON */ }
  return text.slice(0, 300);
}

/**
 * Versand ueber die Sell-Fulfillment-REST-API melden
 * (POST /sell/fulfillment/v1/order/{id}/shipping_fulfillment).
 *
 * Idempotent: vorher wird der Auftrag gelesen. Ist er bei eBay bereits
 * versendet gemeldet, wird KEINE zweite Sendung angelegt — das gilt als
 * Erfolg (egal ob mit unserer oder einer von Hand eingetragenen Nummer).
 *
 * @param {{ order: object, ebayOrderId: string, trackingNumber: string, carrier: string, fetchImpl?: Function }} opts
 * @returns {Promise<{ ok: boolean, marketplace: 'ebay', via: 'fulfillment_api', error?: string, alreadyFulfilled?: boolean }>}
 */
async function pushTrackingToEbayRest({ order, ebayOrderId, trackingNumber, carrier, fetchImpl = fetch }) {
  const base = { marketplace: 'ebay', via: 'fulfillment_api' };
  try {
    const carrierCode = toEbayRestCarrierCode(carrier);
    if (!carrierCode) return { ...base, ok: false, error: `Transporteur "${carrier || '?'}" hat keinen eBay-Code fuer die Fulfillment-API` };

    const { getValidEbayAccessToken } = require('../lib/ebay-oauth');
    const { accessToken, apiBaseUrl } = await getValidEbayAccessToken();
    const root = `${apiBaseUrl || 'https://api.ebay.com'}/sell/fulfillment/v1/order/${encodeURIComponent(ebayOrderId)}`;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_DE',
    };

    const orderRes = await fetchImpl(root, { method: 'GET', headers });
    if (orderRes.status === 404) return { ...base, ok: false, error: 'Order not found on eBay (Fulfillment-API 404)' };
    if (!orderRes.ok) return { ...base, ok: false, error: `Fulfillment-API getOrder HTTP ${orderRes.status}: ${await readRestError(orderRes)}` };
    const ebayOrder = await orderRes.json();

    if (String(ebayOrder?.cancelStatus?.cancelState || '').toUpperCase() === 'CANCELED') {
      return { ...base, ok: false, error: 'Order cancelled on eBay — kein Versand meldbar' };
    }

    const lineItems = (Array.isArray(ebayOrder?.lineItems) ? ebayOrder.lineItems : [])
      .filter((li) => li?.lineItemId && String(li.lineItemFulfillmentStatus || '').toUpperCase() !== 'FULFILLED')
      .map((li) => ({ lineItemId: String(li.lineItemId), quantity: Number(li.quantity) || 1 }));

    if (lineItems.length === 0) {
      console.log(`[marketplace-tracking] eBay ${ebayOrderId} ist bereits als versendet gemeldet — keine zweite Sendung (Fulfillment-API)`);
      return { ...base, ok: true, alreadyFulfilled: true };
    }

    const createRes = await fetchImpl(`${root}/shipping_fulfillment`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        lineItems,
        shippedDate: resolveShippedDate(order),
        shippingCarrierCode: carrierCode,
        trackingNumber: String(trackingNumber),
      }),
    });
    if (!createRes.ok) {
      const detail = await readRestError(createRes);
      // 429 → Kontingent-Signatur, damit die Obergrenze nicht zaehlt.
      const prefix = createRes.status === 429 ? '429 rate limit' : `HTTP ${createRes.status}`;
      return { ...base, ok: false, error: `Fulfillment-API createShippingFulfillment ${prefix}: ${detail}` };
    }
    console.log(`[marketplace-tracking] eBay Fulfillment-API: Versand gemeldet fuer ${ebayOrderId} (${carrierCode} ${trackingNumber}, ${lineItems.length} Position(en))`);
    return { ...base, ok: true };
  } catch (err) {
    console.error(`[marketplace-tracking] eBay Fulfillment-API push failed for ${ebayOrderId}: ${err.message}`);
    return { ...base, ok: false, error: err.message };
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
    const failedUnits = [];

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
        // Retry-Idempotenz: eine bereits gemeldete Unit zaehlt als Erfolg,
        // sonst konvergiert der Retry eines Teilfehlers nie.
        if (isKauflandUnitAlreadyDone(err.message, 'sent')) {
          successCount++;
          console.log(`[marketplace-tracking] Kaufland unit ${unitId} already sent — treated as success`);
        } else {
          failedUnits.push({ unitId, error: err.message });
          console.error(`[marketplace-tracking] Kaufland unit ${unitId} ship failed: ${err.message}`);
        }
      }
    }

    // Teilfehler = Fehler. Vorher galt successCount > 0 als voller Erfolg
    // (marketplacePush.status='success'), womit ensureMarketplaceTrackingPushed
    // und der Catchup-Cron die fehlgeschlagenen Units NIE erneut anfassten —
    // Kaufland sah kein Versand-Confirm, Auto-Cancel + Refund trotz physisch
    // versendeter Ware. Erst wenn ALLE Units durch sind, ist der Push ok.
    if (failedUnits.length > 0) {
      const detail = failedUnits.map((u) => `${u.unitId}: ${u.error}`).join('; ');
      return {
        ok: false,
        marketplace: 'kaufland',
        error: `${failedUnits.length}/${unitIds.length} unit(s) failed: ${detail}`,
        unitsShipped: successCount,
        failedUnitIds: failedUnits.map((u) => u.unitId),
      };
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

  // Already successfully pushed, or abandoned after the retry cap? Don't re-drive.
  if (order.marketplacePush?.status === 'success' || order.marketplacePush?.status === 'abandoned') {
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

// ─── Tracking-Nachholer ─────────────────────────────────────────────────────
//
// Vorfall 2026-09-25/26: 13 eBay-Auftraege wurden morgens um 08:25–09:06 Uhr
// versendet, als das Trading-Tageskontingent leer war. Der Push scheiterte
// (richtig), der Nachholer lief alle 2 h (richtig) — und sah sie trotzdem NIE:
// er fragte `omsStatus=='shipped' AND updatedAt>=cutoff` mit `.limit(50)`, und
// Firestore liefert dann die 50 AELTESTEN. Gemessen: 94 versendete Auftraege im
// Fenster, die 50 zurueckgegebenen reichten vom 21.09. bis 24.09. — alle schon
// erfolgreich gemeldet. Die frischen Fehlschlaege lagen immer hinter Platz 50.
// Bei eBay standen sie 30 h spaeter noch auf NOT_STARTED.
//
// Jetzt: die Fehlschlaege werden DIREKT abgefragt (marketplacePush.status),
// unabhaengig von Auftragsstatus, Aenderungsdatum und Reihenfolge — und auch
// ein inzwischen als zugestellt gefuehrter Auftrag wird noch gemeldet.

const TRACKING_RETRY_STATUSES = new Set(['shipped', 'delivered', 'completed']);
const TRACKING_CATCHUP_MAX_AGE_DAYS = parseInt(process.env.TRACKING_CATCHUP_MAX_AGE_DAYS || '14', 10) || 14;
const CATCHUP_SCAN_LIMIT = 1000;

function toMillisLoose(value) {
  if (!value) return NaN;
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  return Date.parse(value);
}

/**
 * Rein: was tut der Nachholer mit diesem Auftrag?
 *
 * @param {object} order
 * @param {{ nowMs?: number, maxAgeDays?: number, tenantId?: string }} opts
 * @returns {{ action: 'push'|'skip'|'expire', reason?: string, trackingNumber?: string, carrier?: string }}
 */
function classifyTrackingCatchup(order, { nowMs = Date.now(), maxAgeDays = TRACKING_CATCHUP_MAX_AGE_DAYS, tenantId = 'default' } = {}) {
  if (!order) return { action: 'skip', reason: 'no_order' };
  if ((order.tenantId || 'default') !== tenantId) return { action: 'skip', reason: 'other_tenant' };
  const marketplace = String(order.marketplace || order.orderSource || '').toLowerCase();
  if (!['ebay', 'kaufland'].includes(marketplace)) return { action: 'skip', reason: 'no_marketplace' };
  const pushStatus = order.marketplacePush?.status;
  if (pushStatus === 'success' || pushStatus === 'abandoned') return { action: 'skip', reason: `push_${pushStatus}` };
  const status = order.omsStatus || order.status || '';
  if (!TRACKING_RETRY_STATUSES.has(status)) return { action: 'skip', reason: `status_${status || 'unknown'}` };
  const trackingNumber = order.trackingNumber || order.tracking?.trackingNumber;
  if (!trackingNumber) return { action: 'skip', reason: 'no_tracking' };

  const shippedMs = [order.shippedAt, order.marketplacePush?.lastAttempt, order.updatedAt]
    .map(toMillisLoose)
    .find(Number.isFinite);
  if (Number.isFinite(shippedMs) && nowMs - shippedMs > maxAgeDays * 24 * 60 * 60 * 1000) {
    return { action: 'expire', reason: 'catchup_window_expired' };
  }

  const carrier = order.carrier || order.shippingService || order.tracking?.carrier || 'other';
  return { action: 'push', trackingNumber, carrier };
}

let _trackingCatchupRunning = false;

/**
 * Meldet alle versendeten Auftraege nach, deren Tracking-Push gescheitert ist.
 * Laeuft alle 10 min (index.js) — im Normalfall liefert die Abfrage 0 Treffer
 * und kostet einen einzigen Firestore-Lesevorgang.
 *
 * @param {{ tenantId?: string, maxAgeDays?: number, includeNeverPushed?: boolean, nowMs?: number }} opts
 *   includeNeverPushed: zusaetzlich versendete Auftraege OHNE jeden Push-Versuch
 *   suchen (teurer, deshalb nur im 2-h-Lauf).
 */
async function retryFailedTrackingPushes({
  tenantId = 'default',
  maxAgeDays = TRACKING_CATCHUP_MAX_AGE_DAYS,
  includeNeverPushed = false,
  nowMs = Date.now(),
} = {}) {
  const stats = { checked: 0, retried: 0, succeeded: 0, failed: 0, expired: 0 };
  if (_trackingCatchupRunning) return { ...stats, skippedRunning: true };
  _trackingCatchupRunning = true;
  try {
    const db = getDb();
    const candidates = new Map();

    const failedSnap = await db.collection(ORDERS_COLLECTION)
      .where('marketplacePush.status', '==', 'failed')
      .limit(CATCHUP_SCAN_LIMIT)
      .get();
    if (failedSnap.size >= CATCHUP_SCAN_LIMIT) {
      console.warn(`[marketplace-tracking] Nachholer: ${failedSnap.size} fehlgeschlagene Pushes — Obergrenze erreicht, Rest im naechsten Lauf`);
    }
    for (const doc of failedSnap.docs) candidates.set(doc.id, doc);

    if (includeNeverPushed) {
      // Ohne .limit(): ein Limit bei aufsteigender Sortierung war genau der
      // blinde Fleck des alten Nachholers. Das Fenster begrenzt die Menge.
      const cutoff = new Date(nowMs - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
      const shippedSnap = await db.collection(ORDERS_COLLECTION)
        .where('omsStatus', '==', 'shipped')
        .where('updatedAt', '>=', cutoff)
        .get();
      for (const doc of shippedSnap.docs) {
        if (!doc.data().marketplacePush) candidates.set(doc.id, doc);
      }
    }

    for (const doc of candidates.values()) {
      stats.checked++;
      const order = doc.data();
      const decision = classifyTrackingCatchup(order, { nowMs, maxAgeDays, tenantId });
      if (decision.action === 'skip') continue;

      if (decision.action === 'expire') {
        stats.expired++;
        await saveMarketplacePushStatus(doc.ref, {
          ...(order.marketplacePush || {}),
          status: 'abandoned',
          error: `Nachholfenster (${maxAgeDays} Tage) abgelaufen — letzter Fehler: ${order.marketplacePush?.error || 'unbekannt'}`,
          abandonedAt: new Date(nowMs).toISOString(),
        }, doc.id);
        collectError({ type: 'api_error', severity: 'warning', channel: String(order.marketplace || 'internal').toLowerCase(), message: `Tracking-Push nach ${maxAgeDays} Tagen aufgegeben`, entityType: 'order', entityId: doc.id, source: 'marketplace-tracking' });
        continue;
      }

      stats.retried++;
      try {
        const result = await pushTrackingToMarketplace({
          orderId: doc.id,
          trackingNumber: decision.trackingNumber,
          carrier: decision.carrier,
        });
        if (result.ok) stats.succeeded++;
        else stats.failed++;
      } catch (err) {
        stats.failed++;
        console.error(`[marketplace-tracking] Retry tracking push failed for ${doc.id}: ${err.message}`);
      }
    }

    if (stats.retried > 0 || stats.expired > 0) {
      console.log(`[marketplace-tracking] Tracking-Nachholer: checked=${stats.checked} retried=${stats.retried} succeeded=${stats.succeeded} failed=${stats.failed} expired=${stats.expired}`);
    }
    return stats;
  } finally {
    _trackingCatchupRunning = false;
  }
}

/**
 * Catch-up: Find all shipped orders where marketplace push failed or was never done, and retry.
 * Called periodically as a safety net (2h). Der schnelle 10-min-Lauf nutzt
 * retryFailedTrackingPushes() direkt.
 *
 * @param {{ tenantId?: string, maxAge?: number }} opts — maxAge in days (default: 7, nur fuer Stornos)
 * @returns {Promise<{ checked: number, retried: number, succeeded: number, failed: number }>}
 */
async function retryFailedMarketplacePushes({ tenantId = 'default', maxAge = 7 } = {}) {
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAge * 24 * 60 * 60 * 1000).toISOString();

  // 1) Tracking: Fehlschlaege + nie versuchte Pushes
  const tracking = await retryFailedTrackingPushes({ tenantId, includeNeverPushed: true });
  let checked = tracking.checked;
  let retried = tracking.retried;
  let succeeded = tracking.succeeded;
  let failed = tracking.failed;

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
 * Values MUST be PascalCase per Kaufland's enum: BuyerCancelled, ShippingAddressUndeliverable,
 * WrongCatalogData, GeneralAdjustment, MerchandiseNotReceived, NoInventory, DelayedInventory,
 * WrongPrice, NoReactionBuyer, UndeliverableRegion.
 */
const KAUFLAND_CANCEL_REASONS = {
  out_of_stock: 'NoInventory',
  no_inventory: 'NoInventory',
  delayed_inventory: 'DelayedInventory',
  customer_requested: 'BuyerCancelled',
  buyer_cancelled: 'BuyerCancelled',
  defective: 'WrongCatalogData',
  wrong_catalog_data: 'WrongCatalogData',
  wrong_address: 'ShippingAddressUndeliverable',
  shipping_undeliverable: 'ShippingAddressUndeliverable',
  undeliverable_region: 'UndeliverableRegion',
  not_received: 'MerchandiseNotReceived',
  wrong_price: 'WrongPrice',
  no_reaction_buyer: 'NoReactionBuyer',
  other: 'GeneralAdjustment',
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
    const failedUnits = [];

    for (const unitId of unitIds) {
      try {
        await kauflandRequest('PATCH', `/order-units/${unitId}/cancel`, {
          body: { reason: klReason },
        });
        successCount++;
      } catch (err) {
        if (isKauflandUnitAlreadyDone(err.message, 'cancelled')) {
          successCount++;
          console.log(`[marketplace-cancel] Kaufland unit ${unitId} already cancelled — treated as success`);
        } else {
          failedUnits.push({ unitId, error: err.message });
          console.error(`[marketplace-cancel] Kaufland unit ${unitId} cancel failed: ${err.message}`);
        }
      }
    }

    // Gleiche Teilfehler-Regel wie beim Tracking-Push: erst wenn ALLE Units
    // storniert sind, ist der Cancel ok — sonst bleibt eine Unit offen.
    if (failedUnits.length > 0) {
      const detail = failedUnits.map((u) => `${u.unitId}: ${u.error}`).join('; ');
      return {
        ok: false,
        marketplace: 'kaufland',
        error: `${failedUnits.length}/${unitIds.length} unit(s) failed: ${detail}`,
        unitsCancelled: successCount,
        failedUnitIds: failedUnits.map((u) => u.unitId),
      };
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
  pushTrackingToEbayRest,
  pushTrackingToKaufland,
  ensureMarketplaceTrackingPushed,
  retryFailedMarketplacePushes,
  retryFailedTrackingPushes,
  classifyTrackingCatchup,
  toEbayRestCarrierCode,
  resolveShippedDate,
  pushCancellationToMarketplace,
  cancelOrderOnEbay,
  cancelOrderOnKaufland,
  normalizeKauflandCarrier,
  deriveMarketplacePushStatus,
  isRateLimitedError,
  isPermanentPushError,
  isKauflandUnitAlreadyDone,
  MAX_PUSH_ATTEMPTS,
  EBAY_CARRIER_MAP,
  KAUFLAND_CARRIER_MAP,
  KAUFLAND_CANCEL_REASONS,
};
