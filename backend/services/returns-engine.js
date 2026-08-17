'use strict';

/**
 * returns-engine.js — Returns Management Engine.
 *
 * Handles marketplace return intake (eBay + Kaufland), workflow state machine,
 * reason categorization, and refund communication.
 */

const { FieldValue } = require('@google-cloud/firestore');
const { firestore } = require('../lib/firestore');
const { sanitizeText, validateEmail } = require('../lib/html-entities');

const RETURNS_COLLECTION = 'returns';
const ORDERS_COLLECTION = 'orders';
const RETURN_EVENTS_COLLECTION = 'return_events';

function getDb() {
  return firestore;
}

// WP4 (symmetric stock re-credit) — Flag-Spiegel von order-state-machine.js.
// 'false' (default) → heutiges Verhalten exakt. 'shadow'|'true' → idempotenter
// Re-Credit-Claim beim A-Ware-Grading (verhindert Doppel-Credit bei Doppel-Grading).
function recreditMode() {
  const raw = String(process.env.STOCK_RECREDIT_ENABLED || 'false').toLowerCase().trim();
  if (raw === 'true' || raw === 'shadow') return raw;
  return 'false';
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

const VALID_REASONS = new Set(Object.keys(RETURN_REASONS));

/** Validate mapped reason against known enum; fall back to 'sonstiges'. */
function validateReason(mapped, original) {
  if (VALID_REASONS.has(mapped)) return mapped;
  console.warn(`[returns-engine] Unknown return reason: "${original}" mapped to "${mapped}" → falling back to "sonstiges"`);
  return 'sonstiges';
}

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

  // Create Storno / Gutschrift in SevDesk (non-blocking)
  if (refundType !== 'none' && ret.orderId) {
    setImmediate(async () => {
      try {
        const { createCorrectionInvoice } = require('./invoice-engine');
        const corrType = refundType === 'partial' ? 'gutschrift' : 'storno';
        await createCorrectionInvoice({
          orderId: ret.orderId,
          tenantId,
          type: corrType,
          refundAmount: finalAmount || null,
          reason: note || (refundType === 'partial' ? 'Teilerstattung Retoure' : 'Vollerstattung Retoure'),
        });
      } catch (err) {
        console.warn(`[returns-engine] Correction invoice failed (non-blocking) for return ${returnId}: ${err.message}`);
      }
    });
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

  // BUGFIX (2026-07): restockQty MUSS aus der RETOURNIERTEN Menge kommen
  // (ret.product.quantity — eBay: refundedItems.length, Kaufland: kr.quantity),
  // NICHT aus der BESTELLTEN Menge (returnedItem.quantity aus order.items). Bei
  // Teilretoure (N bestellt, weniger zurück) wurde sonst zu viel eingebucht →
  // Phantom-Bestand/Oversell. Cap auf die bestellte Menge als Sicherheitsnetz.
  const returnedQty = Number(ret.product?.quantity || 0);
  const orderedQtyRaw = Number(returnedItem.quantity || 1);
  const orderedQty = Number.isFinite(orderedQtyRaw) && orderedQtyRaw > 0 ? orderedQtyRaw : 1;
  const restockQty = returnedQty > 0 ? Math.min(returnedQty, orderedQty) : orderedQty;

  // HARDEN-6 (2026-05-20): vor diesem Fix wurde NUR ein warehouse_movements-Log
  // geschrieben — die tatsächliche Inventory-Quantity blieb unverändert. Folge:
  // ein Return war "operativ erledigt" aber das Produkt blieb als verkauft
  // markiert → Oversell-Risiko bei jeder Folge-Bestellung.
  //
  // Nur A-Ware automatisch restocken. B-Ware/defekt bleibt manueller Operator-
  // Schritt (Qualitäts-Sichtung → bookStockIn auf B-Ware-BIN durch User).
  let restockResult = null;
  let restockError = null;
  let resolvedBinCode = null;

  if (itemCondition === 'a_ware') {
    try {
      // Bestimme den BIN: letzter bekannter Storage-Bin des Produkts.
      const { firestore, PRODUCTS_COLLECTION } = require('../lib/firestore');
      let productData = null;
      try {
        const productsCol = firestore.collection(PRODUCTS_COLLECTION || 'products_v2');
        // 1) Try SKU via identification
        let prodSnap = await productsCol
          .where('identification.sku', '==', returnedItem.sku || '')
          .where('tenantId', '==', tenantId)
          .limit(1)
          .get();
        if (prodSnap.empty) {
          // 2) Fallback: details.identifiers.sku
          prodSnap = await productsCol
            .where('details.identifiers.sku', '==', returnedItem.sku || '')
            .where('tenantId', '==', tenantId)
            .limit(1)
            .get();
        }
        if (!prodSnap.empty) {
          productData = prodSnap.docs[0].data();
        }
      } catch (lookupErr) {
        console.warn(`[returns/restock] Produkt-Lookup für SKU ${returnedItem.sku} fehlgeschlagen: ${lookupErr.message}`);
      }

      if (productData) {
        // Priorität: storage.binCode > storageBins[0].code
        resolvedBinCode = productData?.storage?.binCode
          || (Array.isArray(productData?.storageBins) && productData.storageBins[0]?.code)
          || null;
      }

      if (resolvedBinCode) {
        // WP4 (flag-gated): idempotenter Re-Credit-Claim auf der Order, damit
        // Doppel-Grading nicht doppelt gutschreibt. Bei flag OFF unveraendert
        // (Gap D: A-Ware bucht heute schon ohne Marker ein).
        const mode = recreditMode();
        let claimAllows = true; // flag OFF → heutiges Verhalten: immer einbuchen
        if (mode !== 'false' && orderId) {
          const skuForClaim = String(returnedItem.sku || '').trim();
          const skus = skuForClaim ? [skuForClaim] : [];
          if (mode === 'shadow') {
            console.log(`[recredit-shadow] order=${orderId} return=${returnId} would claim+bookStockIn sku=${skuForClaim} qty=${restockQty} bin=${resolvedBinCode}`);
            claimAllows = false; // shadow → keine Mutation
          } else {
            try {
              const { claimOrderStockRecreditInTx } = require('../lib/order-stock-recredit-claim');
              const orderRef = db.collection(ORDERS_COLLECTION).doc(orderId);
              const claim = await firestore.runTransaction(async (tx) =>
                claimOrderStockRecreditInTx({ tx, orderRef, by: 'return', skus })
              );
              // Nur einbuchen wenn der Claim gewonnen wurde. never-decremented /
              // already-recredited → kein (weiterer) Credit, aber kein Fehler.
              claimAllows = Boolean(claim.claimed);
              if (!claimAllows) {
                restockError = claim.alreadyRecredited ? 'already-recredited' : (claim.reason || 'not-claimed');
                console.log(`[returns/restock] ${returnedItem.sku}: re-credit skip (${restockError}) for return ${returnId}`);
              }
            } catch (claimErr) {
              console.error(`[returns/restock] re-credit claim failed for ${orderId}: ${claimErr.message}`);
              claimAllows = false;
              restockError = `claim_failed: ${claimErr.message}`;
            }
          }
        }

        if (claimAllows) {
          const { bookStockIn } = require('../lib/warehouse');
          const stockResult = await bookStockIn({
            productId: productData?.id,
            sku: returnedItem.sku || undefined,
            binCode: resolvedBinCode,
            quantity: restockQty,
            meta: {
              source: 'returns-restock',
              returnId,
              orderId,
              condition: itemCondition,
            },
          });
          restockResult = {
            ok: true,
            binCode: resolvedBinCode,
            quantity: restockQty,
            newInventory: stockResult?.product?.inventory?.quantity ?? null,
          };
          console.log(`[returns/restock] ${returnedItem.sku}: +${restockQty} → BIN ${resolvedBinCode} (return ${returnId})`);
        }
      } else {
        // Kein BIN bekannt — kann nicht automatisch restocken. Operator muss
        // bookStockIn manuell durchführen (z.B. via Wareneingangs-Flow).
        restockError = 'no_known_bin';
        console.warn(`[returns/restock] ${returnedItem.sku}: kein BIN bekannt — restock manuell durchführen (return ${returnId})`);
      }
    } catch (err) {
      restockError = err.message || 'unknown_error';
      console.error(`[returns/restock] ${returnedItem.sku}: bookStockIn fehlgeschlagen — ${err.message}`);
    }
  } else {
    // B-Ware / defekt → operator-flow, kein Auto-Restock.
    restockError = 'b_ware_manual_sorting_required';
  }

  // Log warehouse movement for restock — always (audit trail), enriched with
  // result/error so operators can find returns that need manual restocking.
  await db.collection('warehouse_movements').add({
    tenantId,
    type: 'restock_return',
    productSku: returnedItem.sku || null,
    productName: returnedItem.name || null,
    quantity: restockQty,
    condition: itemCondition,
    returnId,
    orderId,
    binCode: resolvedBinCode || null,
    restocked: Boolean(restockResult?.ok),
    restockError: restockError || null,
    newInventory: restockResult?.newInventory ?? null,
    note: restockResult?.ok
      ? `Wiedereinlagerung A-Ware: +${restockQty} → ${resolvedBinCode}`
      : `Restock pending: ${restockError || 'unknown'} (${itemCondition === 'a_ware' ? 'A-Ware' : 'B-Ware'})`,
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

        // Compute refund total and reason BEFORE dedup check (needed for update path too)
        let totalRefund = 0;
        for (const li of refundedItems) {
          for (const ref of (li.refunds || [])) {
            totalRefund += parseFloat(ref.amount?.value || '0') || 0;
          }
        }

        const cancelReason = order.cancelStatus?.cancelReason || '';
        const refundReason = refundedItems[0]?.refunds?.[0]?.reasonType || '';
        const ebayReason = isCanceled ? cancelReason : refundReason;
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
          reason = EBAY_REASON_MAP[refundReason] || 'meinungsaenderung';
        }
        reason = validateReason(reason, ebayReason);

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
          const realName = sanitizeText(shipTo?.fullName) || sanitizeText(shipTo?.contactAddress?.fullName) || null;
          if (realName && (!existingData.customer?.name || existingData.customer.name === order.buyer?.username)) {
            updates.customer = { name: realName, email: validateEmail(shipTo?.email) || existingData.customer?.email || null };
          }
          // Fix missing product name
          const pNames = (order.lineItems || []).map((li) => sanitizeText(li.title)).filter(Boolean);
          if (pNames[0] && (!existingData.product?.name)) {
            updates.product = { ...existingData.product, name: pNames[0] };
          }
          // Fix refundAmount if 0
          if ((!existingData.refundAmount || existingData.refundAmount === 0) && totalRefund > 0) {
            updates.refundAmount = totalRefund;
          }
          // Fix missing reason
          if ((!existingData.reasonRaw || existingData.reason === 'sonstiges') && ebayReason) {
            updates.reasonRaw = ebayReason;
            updates.reason = reason;
          }
          if (Object.keys(updates).length > 0) {
            updates.syncedAt = new Date().toISOString();
            await existingDoc.ref.update(updates);
          }
          skipped++;
          continue;
        }

        const productNames = (order.lineItems || [])
          .map((li) => sanitizeText(li.title))
          .filter(Boolean);

        // Extract real customer name from shipping address (not username)
        const shipTo = order.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo;
        const buyerFullName = sanitizeText(shipTo?.fullName)
          || sanitizeText(shipTo?.contactAddress?.fullName)
          || order.buyer?.username
          || null;
        const buyerEmail = validateEmail(shipTo?.email) || validateEmail(order.buyer?.email);

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

        // Deterministic doc ID prevents duplicates from parallel syncs
        const docId = `ebay__${marketplaceReturnId}`;
        await db.collection(RETURNS_COLLECTION).doc(docId).set(returnDoc, { merge: true });
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

    // Paginate through all Kaufland returns
    let allReturns = [];
    let offset = 0;
    const PAGE_LIMIT = 100;
    const MAX_RETURNS = 5000; // Safety limit

    do {
      const result = await kauflandRequest('GET', '/returns', {
        query: { limit: PAGE_LIMIT, offset },
      });

      const responseBody = result?.data || {};
      const batch = Array.isArray(responseBody?.data) ? responseBody.data : [];
      allReturns = allReturns.concat(batch);

      if (batch.length < PAGE_LIMIT) break; // Last page
      offset += batch.length;
    } while (offset < MAX_RETURNS);

    if (allReturns.length > 0) {
      console.log(`[returns-engine] Kaufland: fetched ${allReturns.length} returns (${Math.ceil(allReturns.length / PAGE_LIMIT)} pages)`);
    }

    for (const kr of allReturns) {
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
        const returnUnitId = firstUnit.id_return_unit ? String(firstUnit.id_return_unit) : null;
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
          if (returnUnitId && !existingData.returnUnitId) {
            updates.returnUnitId = returnUnitId;
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
              .where('tenantId', '==', tenantId)
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

        const reason = validateReason(
          KAUFLAND_REASON_MAP[unitReason] || KAUFLAND_REASON_MAP[unitReason.toLowerCase()] || 'sonstiges',
          unitReason
        );

        // Build customer & product from order-unit detail
        const ouBuyer = orderUnitDetail?.buyer || {};
        const ouProduct = orderUnitDetail?.product || {};
        const ouShipping = orderUnitDetail?.shipping_address || orderUnitDetail?.billing_address || {};
        const buyerName = ouShipping.first_name && ouShipping.last_name
          ? sanitizeText(`${ouShipping.first_name} ${ouShipping.last_name}`)
          : sanitizeText(kr.buyer_name || kr.buyer?.name) || null;

        const returnDoc = {
          tenantId,
          marketplace: 'kaufland',
          marketplaceReturnId,
          marketplaceOrderId: orderUnitDetail?.id_order || orderUnitId,
          orderUnitId,
          returnUnitId,
          orderId: null,
          customer: {
            name: buyerName,
            email: validateEmail(ouBuyer.email) || validateEmail(kr.buyer_email),
          },
          product: {
            name: sanitizeText(ouProduct.title) || sanitizeText(kr.product_title) || sanitizeText(kr.title) || null,
            sku: orderUnitDetail?.id_offer || (kr.id_offer ? String(kr.id_offer) : null),
            quantity: kr.quantity || 1,
            ean: ouProduct.eans?.[0] || null,
            price: orderUnitDetail?.price ? (orderUnitDetail.price / 100) : null,
          },
          reason,
          reasonRaw: unitReason,
          reasonText: sanitizeText(firstUnit.note) || sanitizeText(kr.reason_comment) || null,
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

        // Deterministic doc ID prevents duplicates from parallel syncs
        const docId = `kaufland__${marketplaceReturnId}`;
        await db.collection(RETURNS_COLLECTION).doc(docId).set(returnDoc, { merge: true });
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

    // Kaufland accepts at the return-unit level (not the return level).
    // Endpoint: PATCH /v2/return-units/{id_return_unit}/accept (no body).
    // Auto-refund happens server-side when the unit is accepted.
    let returnUnitIds = [];
    if (ret.returnUnitId) {
      returnUnitIds.push(String(ret.returnUnitId));
    } else {
      // Backfill: fetch the return-units for this return from Kaufland
      try {
        const detailRes = await kauflandRequest('GET', `/returns/${marketplaceReturnId}`, {
          query: { 'embedded[]': 'return_units' },
        });
        const units = detailRes?.data?.data?.return_units || [];
        returnUnitIds = units.map((u) => u.id_return_unit ? String(u.id_return_unit) : null).filter(Boolean);
        if (returnUnitIds.length && !ret.returnUnitId) {
          await getDb().collection(RETURNS_COLLECTION).doc(returnId).set({
            returnUnitId: returnUnitIds[0],
          }, { merge: true });
        }
      } catch (lookupErr) {
        return { ok: false, marketplace: 'kaufland', error: `Return-unit lookup failed: ${lookupErr.message}` };
      }
    }

    if (!returnUnitIds.length) {
      return { ok: false, marketplace: 'kaufland', error: 'No return_unit IDs found' };
    }

    let success = 0;
    let lastError = null;
    for (const ruid of returnUnitIds) {
      try {
        await kauflandRequest('PATCH', `/return-units/${ruid}/accept`);
        success++;
      } catch (err) {
        lastError = err.message;
        console.error(`[returns-engine] Kaufland return-unit ${ruid} accept failed: ${err.message}`);
      }
    }

    if (success === 0) {
      return { ok: false, marketplace: 'kaufland', error: lastError || 'All return-unit accepts failed' };
    }

    console.log(`[returns-engine] Kaufland refund for return ${marketplaceReturnId}: ${success}/${returnUnitIds.length} units accepted`);

    await getDb().collection(RETURNS_COLLECTION).doc(returnId).set({
      marketplaceRefundStatus: 'issued',
      marketplaceRefundAt: new Date().toISOString(),
    }, { merge: true });

    return { ok: true, marketplace: 'kaufland', unitsAccepted: success };
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

/**
 * Auto-push pending refunds to marketplaces.
 * Finds returns in 'erstattet' or 'teilweise_erstattet' status that haven't
 * been pushed to their marketplace yet, and issues the refund.
 *
 * @param {{ tenantId?: string, limit?: number }} opts
 * @returns {Promise<{ processed: number, success: number, errors: string[] }>}
 */
/**
 * Darf AvyCloud selbst Erstattungen an eBay/Kaufland schicken?
 *
 * Betreiber-Anweisung 2026-08-17: NEIN. Die Marktplaetze erstatten automatisch,
 * sobald die Retoure mit Sendungsverfolgung eintrifft. Ein zweiter
 * Erstattungsweg aus AvyCloud heraus ist damit ein Pfad fuer DOPPELTE
 * Erstattungen — echtes Geld an den Kunden, zweimal.
 *
 * Der Weg bleibt im Code (ein anderer Betreiber koennte ihn brauchen), aber er
 * ist fail-closed: NUR der ausdrueckliche Wert 'on' schaltet ihn ein. Alles
 * andere, auch 'true' oder '1', laesst ihn aus — ein Tippfehler in der
 * Konfiguration darf hier kein Geld bewegen.
 */
function marketplaceRefundPushEnabled() {
  return String(process.env.MARKETPLACE_REFUND_PUSH || '').trim().toLowerCase() === 'on';
}

async function runRefundPush({ tenantId = 'default', limit = 50 } = {}) {
  if (!marketplaceRefundPushEnabled()) {
    // Ohne Log-Rauschen: das ist der NORMALFALL, kein Fehler.
    return { processed: 0, success: 0, errors: [], skipped: true, reason: 'marketplace_refund_push_disabled' };
  }
  const db = getDb();
  const errors = [];
  let processed = 0;
  let success = 0;

  // HARDEN-1 (2026-05-20): Cross-Tenant-Schutz — die Queries MÜSSEN nach tenantId filtern,
  // sonst greift sich Tenant A ein Return von Tenant B und ruft `issueMarketplaceRefund`
  // mit den Credentials von A auf → fremder Marketplace-Account, Geldfluss / Compliance-Bruch.
  // Siehe docs/kb/17-cleanup-report.md + Hardening-Plan Wave 1.
  const normalizedTenantId = String(tenantId || 'default').trim() || 'default';

  // Find returns that need marketplace refund push
  const refundStatuses = ['erstattet', 'teilweise_erstattet'];
  for (const status of refundStatuses) {
    const snap = await db.collection(RETURNS_COLLECTION)
      .where('tenantId', '==', normalizedTenantId)
      .where('status', '==', status)
      .where('marketplaceRefundPushed', '==', false)
      .limit(limit)
      .get();

    // Also check returns without the field set (legacy)
    const snapLegacy = await db.collection(RETURNS_COLLECTION)
      .where('tenantId', '==', normalizedTenantId)
      .where('status', '==', status)
      .limit(limit)
      .get();

    const docs = new Map();
    snap.docs.forEach((d) => docs.set(d.id, d));
    snapLegacy.docs.forEach((d) => {
      const data = d.data();
      if (!data.marketplaceRefundPushed && !docs.has(d.id)) docs.set(d.id, d);
    });

    for (const [returnId, doc] of docs) {
      const data = doc.data();
      const mp = (data.marketplace || '').toLowerCase();
      if (!mp || (mp !== 'ebay' && mp !== 'kaufland')) continue;

      // Defense-in-depth: trotz query-filter prüfen wir den tenantId am Doc nochmal —
      // schützt vor Indizes / Legacy-Docs ohne Feld.
      const docTenant = String(data.tenantId || '').trim();
      if (docTenant && docTenant !== normalizedTenantId) {
        console.warn(`[returns/refund-push] tenant mismatch returnId=${returnId} doc=${docTenant} requested=${normalizedTenantId} — skipping`);
        continue;
      }

      processed++;
      try {
        // BUGFIX (2026-07): issueMarketplaceRefund WIRFT NICHT bei fehlgeschlagener
        // Erstattung — issueEbayRefund/issueKauflandRefund fangen API-Fehler und
        // liefern { ok:false, error }. Vorher wurde JEDES Ergebnis als Erfolg
        // gewertet → marketplaceRefundPushed:true gesetzt, obwohl der Kunde nie
        // erstattet wurde, und die Retry-Query (marketplaceRefundPushed!=true)
        // versuchte es nie erneut. Jetzt: nur bei r.ok===true als Erfolg werten.
        const r = await issueMarketplaceRefund({ returnId, tenantId: normalizedTenantId });
        if (r && r.ok === true) {
          await doc.ref.set({ marketplaceRefundPushed: true, marketplaceRefundPushedAt: new Date().toISOString() }, { merge: true });
          success++;
        } else {
          // marketplaceRefundPushed NICHT setzen → nächster Push-Lauf greift es erneut auf.
          errors.push(`${returnId}: ${(r && r.error) || 'refund not ok'}`);
        }
      } catch (err) {
        errors.push(`${returnId}: ${err.message}`);
      }
    }
  }

  if (processed > 0) {
    console.log(`[returns-engine] Refund push: ${success}/${processed} successful${errors.length ? `, ${errors.length} errors` : ''}`);
  }

  return { processed, success, errors };
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
  runRefundPush,
  marketplaceRefundPushEnabled,

  // Constants
  RETURN_STATUSES,
  VALID_TRANSITIONS,
  RETURN_REASONS,
  EBAY_REASON_MAP,
  KAUFLAND_REASON_MAP,
};
