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
const { detectSwappedZipCity } = require('../lib/postal-code-validate');
const { getNextNumber } = require('./number-sequence');
const { reserveStock } = require('./stock-reservation');
const { syncStockWithRetry, findProductsBySkuChunk } = require('./stock-sync-dispatcher');
const { emitSyncEvent } = require('./sync-event-bus');
const { sendOpsAlert } = require('../lib/ops-alert');
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
  modTimeFrom,
  modTimeTo,
  pageNumber = 1,
  entriesPerPage = 50,
  orderRole = 'Seller',
  orderStatus = 'All',
  priority = null,
} = {}) {
  // Default: last 7 days
  const now = new Date();
  // ModTime (geaendert im Fenster) und CreateTime (angelegt im Fenster) schliessen
  // sich bei GetOrders gegenseitig aus. ModTime ist der Abgleich-Weg: er liefert
  // nur, was sich seit dem letzten Lauf bei eBay bewegt hat.
  let timeFilter;
  if (modTimeFrom) {
    timeFilter = `
    <ModTimeFrom>${modTimeFrom}</ModTimeFrom>
    <ModTimeTo>${modTimeTo || now.toISOString()}</ModTimeTo>`;
  } else {
    const from = createTimeFrom || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const to = createTimeTo || now.toISOString();
    timeFilter = `
    <CreateTimeFrom>${from}</CreateTimeFrom>
    <CreateTimeTo>${to}</CreateTimeTo>`;
  }

  const innerXml = `${timeFilter}
    <OrderRole>${orderRole}</OrderRole>
    <OrderStatus>${orderStatus}</OrderStatus>
    <Pagination>
      <EntriesPerPage>${entriesPerPage}</EntriesPerPage>
      <PageNumber>${pageNumber}</PageNumber>
    </Pagination>
  `;

  // priority: Tagesbudget-Prioritaet (lib/ebay-trading-budget.js) — Worker-
  // Fast-Poll P0, Abgleiche P1/P2, UI-Syncs P2.
  const result = await callTradingApi('GetOrders', innerXml, { timeoutMs: 30000, priority: priority || undefined });
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

  // eBay validiert internationale Adressfelder NICHT und reicht durch, was der
  // Käufer eingetippt hat. Auftrag 07-14991-66886 (2026-08-04) kam mit
  // CityName=2000 / PostalCode="Antwerpen" herein — vertauscht. Daraus konnte
  // nie ein Label werden; gemerkt hat es erst SendCloud, 40 min später.
  // Hier an der QUELLE drehen, damit Rechnung, Lieferschein, Adresslabel und
  // Versandlabel dieselbe richtige Adresse sehen. Nur bei Beweis (PLZ
  // nachweislich ungültig fürs Land UND Stadt ist gültige PLZ desselben
  // Landes) — sonst bleibt alles unangetastet, siehe lib/postal-code-validate.
  const rawCity = sanitizeText(shippingAddr?.CityName) || null;
  const rawZip = shippingAddr?.PostalCode != null ? String(shippingAddr.PostalCode).trim() : null;
  const addrCountry = shippingAddr?.Country || null;
  const swap = detectSwappedZipCity(rawZip, rawCity, addrCountry);
  if (swap.swapped) {
    console.warn(
      `[ebay-intake] Order ${ebayOrder?.OrderID}: PLZ/Stadt von eBay vertauscht — korrigiert. ` +
      `PLZ "${rawZip}"→"${swap.zip}", Stadt "${rawCity}"→"${swap.city}" (${addrCountry}).`
    );
  }
  const customerCity = swap.swapped ? swap.city : rawCity;
  const customerZip = swap.swapped ? swap.zip : rawZip;

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
      city: customerCity,
      zip: customerZip,
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
 * @param {{ tenantId?: string, lookbackDays?: number, skipIfFreshMs?: number, priority?: string|null }} opts
 *   skipIfFreshMs — liegt der letzte ERFOLGREICHE Import (irgendein Prozess,
 *   geteilter Marker ops/ebayOrderIntake__<tenant>) weniger als N ms zurueck,
 *   wird KEIN eBay-Aufruf gemacht (Default 0 = immer importieren).
 *   priority — Tagesbudget-Prioritaet des Intake-GetOrders (Default P1).
 * @returns {Promise<{ synced: number, skipped: number, total: number }>}
 */
async function syncEbayOrders({ tenantId = 'default', lookbackDays = 7, skipIfFreshMs = 0, priority = null } = {}) {
  // eBay Trading API hard limit: CreateTimeFrom cannot be older than 90 days
  const cappedDays = Math.min(lookbackDays, 90);
  const now = new Date();
  const from = new Date(now.getTime() - cappedDays * 24 * 60 * 60 * 1000).toISOString();

  // Geteilter Zustand (seit 2026-10-08): Frische-Marker + Abgleich-Takt ueber
  // alle Prozesse (Web-Instanzen + Worker). null = nicht lesbar → fail-open.
  const shared = await readSharedIntakeState(tenantId);
  const freshMs = Number(skipIfFreshMs) > 0 ? Number(skipIfFreshMs) : 0;
  if (freshMs > 0 && shared && shared.lastIntakeOkAtIso) {
    const ageMs = now.getTime() - Date.parse(shared.lastIntakeOkAtIso);
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < freshMs) {
      console.log(`[ebay-intake] uebersprungen: letzter erfolgreicher Import vor ${Math.round(ageMs / 1000)}s (${shared.lastIntakeProcess || 'unbekannt'}) — kein GetOrders`);
      return { synced: 0, skipped: 0, total: 0, skippedFresh: true, lastIntakeOkAtIso: shared.lastIntakeOkAtIso, lastIntakeProcess: shared.lastIntakeProcess || null };
    }
  }
  // Sicherheitsnetz-Eskalation (Gegenlese): ein Web-/Event-Sync mit Frische-
  // Schranke ist nur solange Komfort (P2), wie der Worker lebt. Altert der
  // Marker, importiert offensichtlich niemand mehr — dann muss der Aufruf
  // steigen, sonst bliebe unter der P2-Reserve jede neue Bestellung ohne
  // Reservierung: < 20 min P2, < 60 min P1, danach (oder ohne Marker) P0.
  const intakePriority = freshMs > 0
    ? escalateIntakePriority(priority || 'P2', shared && shared.lastIntakeOkAtIso ? now.getTime() - Date.parse(shared.lastIntakeOkAtIso) : null)
    : (priority || 'P1');

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
      priority: intakePriority,
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

        // Reserve stock IMMEDIATELY after save — not after the loop.
        // Nur für Orders im offenen Lifecycle: eine Order, die bereits
        // storniert/versendet ankommt (Backfill, Storno vor Erst-Intake),
        // bekäme eine Phantom-Reservierung ohne Release-Pfad —
        // _onOrderCancelled läuft nur bei einer Transition NACH cancelled,
        // die hier nie stattfindet. Bei qty-1-SKUs endet das im fälschlichen
        // Listing-End. Born-shipped dekrementiert separat via processShippedOrder.
        const { RESERVED_ORDER_STATUSES } = require('../lib/order-status-helpers');
        const initialOms = order.ebayStatus || 'pending';
        if (!RESERVED_ORDER_STATUSES.has(initialOms)) {
          console.log(`[ebay-intake] skip reservation for ${order.marketplaceOrderId} (initial status ${initialOms})`);
        } else {
          try {
            const orderId = `ebay__${order.marketplaceOrderId}`;
            const items = (order.items || []).map((item) => ({
              sku: item.sku || null,
              quantity: item.quantity || 1,
            }));
            await reserveStock({ tenantId, orderId, items });
          } catch (err) {
            console.warn(`[ebay-intake] reserveStock failed for ${order.marketplaceOrderId}: ${err.message}`);
            // Oversell precursor: a sold item was not reserved, no durable retry. Alert a human.
            sendOpsAlert({
              source: 'order-intake-ebay',
              severity: 'critical',
              tenantId,
              message: `reserveStock failed for order ${order.marketplaceOrderId}: ${err.message}`,
              context: { marketplaceOrderId: order.marketplaceOrderId },
            }).catch(() => {});
          }
        }
      } else {
        totalSkipped++;
      }
    }

    page++;
    if (page > result.totalPages) break;
  } while (page <= 50); // Safety limit

  // Erfolgreicher Intake → geteilter Frische-Marker (andere Prozesse koennen
  // ihren Import ueberspringen, solange er frisch ist).
  await writeSharedIntakeState(tenantId, {
    lastIntakeOkAtIso: new Date().toISOString(),
    lastIntakeProcess: currentProcessRole(),
    lastIntakeLookbackDays: cappedDays,
  });

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
            sendOpsAlert({
              source: 'order-intake-ebay',
              severity: 'critical',
              tenantId,
              message: `stock sync threw for product ${product.id}: ${err.message}`,
              context: { productId: product.id, reason: 'ebay-order-intake' },
            }).catch(() => {});
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
  const startedAtMs = Date.now();
  // Takt-Zustand anderer Prozesse uebernehmen (neuester Stand gewinnt) — sonst
  // beginnt jede neue Cloud-Run-Instanz mit einem 6-Seiten-30-Tage-Abgleich.
  // Direkt vor dem Planen ERNEUT lesen (Gegenlese): der Intake oben dauert
  // Sekunden bis Minuten, ein anderer Prozess kann inzwischen abgeglichen haben.
  const latestShared = await readSharedIntakeState(tenantId);
  mergeSharedReconcileState(_reconcileState, latestShared || shared);
  const plan = planReconciliation(startedAtMs);
  if (plan.mode !== 'skip') {
    markReconciliationAttempt(startedAtMs);
    await writeSharedIntakeState(tenantId, { reconcile: { lastAttemptAtIso: new Date(startedAtMs).toISOString() } });
    const reconcileDays = parseInt(process.env.RECONCILIATION_MAX_AGE_DAYS || '30', 10);
    const runReconcile = async (mode, modTimeFromMs) => {
      const recWindow = mode === 'full'
        ? { createTimeFrom: new Date(startedAtMs - reconcileDays * 24 * 60 * 60 * 1000).toISOString(), createTimeTo: now.toISOString() }
        : { modTimeFrom: new Date(modTimeFromMs).toISOString(), modTimeTo: new Date(startedAtMs).toISOString() };
      // Voll-Abgleich ist Komfort (P2), der inkrementelle ist wichtig (P1).
      const recPriority = mode === 'full' ? 'P2' : 'P1';
      let recPage = 1;
      let recChecked = 0;
      do {
        const result = await fetchEbayOrders({ ...recWindow, pageNumber: recPage, entriesPerPage: 100, priority: recPriority });
        for (const order of result.orders) {
          await saveOrderIfNew({ tenantId, order });
          recChecked++;
        }
        recPage++;
        if (recPage > result.totalPages) break;
      } while (recPage <= 50);
      markReconciliationDone(mode, startedAtMs);
      const reconcilePatch = { lastAttemptAtIso: new Date(startedAtMs).toISOString(), lastMode: mode, lastDoneAtIso: new Date().toISOString() };
      if (mode === 'full') reconcilePatch.lastFullStartedAtIso = new Date(startedAtMs).toISOString();
      await writeSharedIntakeState(tenantId, { reconcile: reconcilePatch });
      console.log(`[ebay-intake] Status reconciliation (${mode}): checked ${recChecked} orders (${recPage - 1} page(s))`);
    };
    try {
      await runReconcile(plan.mode, plan.modTimeFromMs);
    } catch (err) {
      // Verweigert das Tagesbudget den Voll-Abgleich (P2), darf der wichtige
      // inkrementelle (P1) nicht mit ihm verhungern (Gegenlese): sofort ab dem
      // letzten erfolgreichen Voll-Lauf nachziehen; der Voll-Lauf bleibt faellig.
      const budgetDeferred = Boolean(err && (err.budgetDeferred || err.code === 'EBAY_BUDGET_DEFERRED'));
      if (budgetDeferred && plan.mode === 'full' && _reconcileState.lastFullStartedAtMs > 0) {
        console.warn(`[ebay-intake] Voll-Abgleich vom Tagesbudget zurueckgestellt — inkrementeller Abgleich (P1) laeuft stattdessen: ${err.message}`);
        try {
          await runReconcile('incremental', _reconcileState.lastFullStartedAtMs - RECONCILE_OVERLAP_MS);
        } catch (incErr) {
          console.warn(`[ebay-intake] Status reconciliation failed: ${incErr.message}`);
        }
      } else {
        console.warn(`[ebay-intake] Status reconciliation failed: ${err.message}`);
      }
    }
  }

  return { synced: totalSynced, skipped: totalSkipped, total: totalEntries };
}

// ─── Abgleich-Taktung (seit 2026-09-26) ─────────────────────────────────────
//
// Vorher lief bei JEDEM syncEbayOrders-Aufruf ein Voll-Abgleich ueber 30 Tage
// (bei ~400 Auftraegen 4+ GetOrders-Seiten, wachsend mit dem Umsatz) — auch
// beim 5-min-Fast-Poll, dessen Kommentar in index.js ausdruecklich "KEIN
// 30d-Reconcile" verspricht, und bei jedem Oberflaechen-Abgleich (gemessen:
// 243 Laeufe in 6 h allein auf dem Web-Dienst). Gemessen am 26.09.: GetOrders
// verbrauchte 1.760 von 2.460 Trading-Aufrufen seit dem Tages-Reset — 72 %.
// Das Tageskontingent (5.000 fuer ALLE Trading-Aufrufe zusammen) war an fast
// jedem Tag ab ~00:30 UTC leer, bis zum Reset um 07:00 UTC: kein Auftrags-
// Import, kein Bestandsabgleich, kein Versand-Melden (Vorfall 25.09.).
//
// Jetzt:
//   full         — 30-Tage-Abgleich wie bisher, hoechstens alle 3 h je Prozess
//                  (Sicherheitsnetz, faengt alles, was ModTime verpassen koennte)
//   incremental  — nur Auftraege, die eBay seit dem Beginn des letzten Voll-
//                  Abgleichs geaendert hat (ModTimeFrom); im Normalfall EINE Seite
//   skip         — weniger als 4 min seit dem letzten Abgleich-VERSUCH: nur die
//                  Neuanlage (Intake). Die Sperre gilt auch fuer einen
//                  gescheiterten Voll-Lauf — sonst wiederholte jeder Aufruf die
//                  30-Tage-Abfrage und der alte Verbrauch waere zurueck.
//
// Lueckenlos: das inkrementelle Fenster beginnt immer beim START des letzten
// ERFOLGREICHEN Voll-Abgleichs (minus Ueberlappung) — alles davor hat der
// Voll-Abgleich gesehen, alles danach sieht ModTime. Scheitert ein Voll-Lauf,
// bleibt der alte Startpunkt stehen und der Voll-Lauf bleibt faellig.
//
// Notbremse: EBAY_RECONCILE_MODE='full' stellt das alte Verhalten her.

const RECONCILE_FULL_INTERVAL_MS = parseInt(process.env.EBAY_RECONCILE_FULL_INTERVAL_MS || String(3 * 60 * 60 * 1000), 10);
const RECONCILE_MIN_INTERVAL_MS = parseInt(process.env.EBAY_RECONCILE_MIN_INTERVAL_MS || String(4 * 60 * 1000), 10);
const RECONCILE_OVERLAP_MS = 10 * 60 * 1000;

const _reconcileState = { lastFullStartedAtMs: 0, lastAttemptAtMs: 0 };

/**
 * Rein bis auf den uebergebenen Zustand: welcher Abgleich ist jetzt faellig?
 * @param {number} nowMs
 * @returns {{ mode: 'full'|'incremental'|'skip', modTimeFromMs?: number }}
 */
function planReconciliation(nowMs, state = _reconcileState) {
  if (String(process.env.EBAY_RECONCILE_MODE || '').trim().toLowerCase() === 'full') return { mode: 'full' };
  if (state.lastAttemptAtMs && nowMs - state.lastAttemptAtMs < RECONCILE_MIN_INTERVAL_MS) return { mode: 'skip' };
  if (!state.lastFullStartedAtMs || nowMs - state.lastFullStartedAtMs >= RECONCILE_FULL_INTERVAL_MS) {
    return { mode: 'full' };
  }
  return { mode: 'incremental', modTimeFromMs: state.lastFullStartedAtMs - RECONCILE_OVERLAP_MS };
}

function markReconciliationAttempt(startedAtMs, state = _reconcileState) {
  state.lastAttemptAtMs = startedAtMs;
}

function markReconciliationDone(mode, startedAtMs, state = _reconcileState) {
  if (mode === 'full') state.lastFullStartedAtMs = startedAtMs;
}

function _resetReconcileStateForTests() {
  _reconcileState.lastFullStartedAtMs = 0;
  _reconcileState.lastAttemptAtMs = 0;
}

// ─── Geteilter Intake-Zustand (seit 2026-10-08) ─────────────────────────────
//
// Vorher hielt JEDER Prozess seinen eigenen Abgleich-Takt: jede neue Web-
// Instanz begann mit einem 6-Seiten-30-Tage-Abgleich (gemessen 06.10.: 20 Web-
// Voll-Laeufe statt hoechstens 8), k Web-Instanzen fuhren k parallele 4-min-
// Takte, und 1.127 UI-Syncs am 06.10. (Handscanner alle 30 s) kosteten je
// 2+ GetOrders, obwohl der Worker alle 5 min ohnehin importiert. Das Doc
// ops/ebayOrderIntake__<tenant> macht Frische-Marker und Takt fuer alle
// Prozesse sichtbar. Jeder Zugriff ist fail-open: ohne Firestore gilt der
// lokale Zustand und der Import laeuft wie bisher.
const INTAKE_STATE_DOC_PREFIX = 'ebayOrderIntake__';

function intakeStateRef(tenantId) {
  return getDb().collection('ops').doc(`${INTAKE_STATE_DOC_PREFIX}${String(tenantId || 'default')}`);
}

async function readSharedIntakeState(tenantId) {
  try {
    const snap = await intakeStateRef(tenantId).get();
    return snap && snap.exists ? (snap.data() || {}) : {};
  } catch (err) {
    console.warn(`[ebay-intake] geteilter Zustand nicht lesbar (fail-open): ${err.message}`);
    return null;
  }
}

async function writeSharedIntakeState(tenantId, patch) {
  try {
    await intakeStateRef(tenantId).set({ tenantId: String(tenantId || 'default'), ...patch, updatedAt: new Date().toISOString() }, { merge: true });
  } catch (err) {
    console.warn(`[ebay-intake] geteilter Zustand nicht schreibbar: ${err.message}`);
  }
}

function currentProcessRole() {
  try {
    return require('../lib/process-role').shouldRunBackgroundJobs() ? 'worker' : 'web';
  } catch (_) {
    return 'unknown';
  }
}

/**
 * Prioritaet eines Syncs MIT Frische-Schranke nach dem Alter des letzten
 * erfolgreichen Imports: solange der Worker lebt, Komfort; stirbt er, muss das
 * Sicherheitsnetz steigen, bis zum Boden (P0). Rein, exportiert fuer Tests.
 */
function escalateIntakePriority(basePriority, markerAgeMs) {
  const rank = { P0: 0, P1: 1, P2: 2 };
  const base = rank[basePriority] != null ? basePriority : 'P2';
  if (markerAgeMs == null || !Number.isFinite(markerAgeMs)) return 'P0'; // nie importiert / Marker unlesbar
  if (markerAgeMs < 20 * 60 * 1000) return base;
  if (markerAgeMs < 60 * 60 * 1000) return rank[base] < 1 ? base : 'P1';
  return 'P0';
}

/** Neuester Stand gewinnt — lokal UND geteilt, damit kein Prozess zurueckfaellt. */
function mergeSharedReconcileState(local, shared) {
  const r = shared && shared.reconcile;
  if (!r || typeof r !== 'object') return local;
  const full = Date.parse(r.lastFullStartedAtIso || '');
  const attempt = Date.parse(r.lastAttemptAtIso || '');
  if (Number.isFinite(full) && full > (local.lastFullStartedAtMs || 0)) local.lastFullStartedAtMs = full;
  if (Number.isFinite(attempt) && attempt > (local.lastAttemptAtMs || 0)) local.lastAttemptAtMs = attempt;
  return local;
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
      // on_hold hat sortOrder 11 (reine UI-Sortierposition ans Listenende) — als
      // currentRank würde das JEDEN Fortschritt blockieren: unbezahlte Orders
      // starten als on_hold, und nach Zahlung meldet eBay confirmed/shipped
      // (Rank 1/6 < 11) → Order bliebe für immer 'Pausiert', Ship-Decrement
      // liefe nie (Oversell-Fenster nach Reservierungsablauf). Wie im
      // Kaufland-Intake (OMS_RANK ohne on_hold → ?? 0) gilt on_hold deshalb
      // beim Vergleich als niedrigster Zustand.
      const currentRank = currentOms === 'on_hold' ? 0 : Math.max(0, getOmsSortOrder(currentOms));
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

  // Unbezahlte Orders (z.B. angenommener Preisvorschlag vor Zahlung) NICHT
  // anlegen: eBay meldet sie mit einer transaktions-basierten OrderID
  // (itemId-transactionId), die sich bei Zahlung ÄNDERT — die bezahlte Order
  // kommt als NEUES GetOrders-Objekt mit finaler OrderID. Ein früh angelegtes
  // on_hold-Doc bliebe für immer als "Pausiert"-Zombie stehen und würde den
  // Bestand DOPPELT reservieren (Incident 2026-07-10: 2 Duplikat-Aufträge zu
  // bereits versendeten Bestellungen). Erst nach Zahlung übernehmen.
  if (order.ebayStatus === 'on_hold') {
    console.log(`[ebay-intake] skip unpaid order ${order.marketplaceOrderId} — wird nach Zahlung als eigene Order übernommen`);
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
  planReconciliation,
  markReconciliationAttempt,
  markReconciliationDone,
  mergeSharedReconcileState,
  readSharedIntakeState,
  escalateIntakePriority,
  INTAKE_STATE_DOC_PREFIX,
  _resetReconcileStateForTests,
};
