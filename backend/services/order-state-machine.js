'use strict';

/**
 * order-state-machine.js — Status-Engine für das AvyCloud OMS.
 *
 * Definiert den Order-Status-Flow und validiert Übergänge.
 * Jeder Übergang wird als Event in der `order_events` Collection protokolliert.
 *
 * Flow: pending → confirmed → picking → picked → packing → packed → shipped → delivered → completed
 * Sonderstatus: cancelled, returned, on_hold
 */

const { Firestore, FieldValue } = require('@google-cloud/firestore');

const ORDER_EVENTS_COLLECTION = 'order_events';
const ORDERS_COLLECTION = 'orders';

let _db;
function getDb() {
  if (!_db) _db = new Firestore();
  return _db;
}

// ─── WP4: Symmetric Stock Re-Credit (flag-gated, INERT by default) ────────
//
// STOCK_RECREDIT_ENABLED steuert die symmetrische Bestands-Gutschrift bei
// Cancel/Return/Label-Cancel:
//   'false'  (default) → heutiges Verhalten exakt. KEINE neue Mutation.
//   'shadow'           → vollstaendige Entscheidung + Log `[recredit-shadow] …`,
//                        aber KEIN bookStockIn und KEINE Marker-Writes.
//   'true'              → realer Re-Credit-Pfad.
//
// Oversell-Safety ruht auf: nie gutschreiben ohne vorherigen Decrement,
// hoechstens eine Gutschrift pro Order (claimOrderStockRecreditInTx-Marker),
// NIEMALS Auto-Gutschrift einer defekten Retoure (B/C-Ware bleibt manuell).
function recreditMode() {
  const raw = String(process.env.STOCK_RECREDIT_ENABLED || 'false').toLowerCase().trim();
  if (raw === 'true' || raw === 'shadow') return raw;
  return 'false';
}

// Fallback-BIN, falls ein Produkt beim Re-Credit keinen bekannten Storage-BIN
// hat. Optional via ENV; sonst kein Fallback (SKU wird als Failure gequeued).
function recreditFallbackBin() {
  const v = String(process.env.RECREDIT_FALLBACK_BIN || '').trim();
  return v || null;
}

// ─── Status Definitions ──────────────────────────────────────

const ORDER_STATUSES = {
  pending:    { label: 'Neu',           color: 'blue',   sortOrder: 0 },
  confirmed:  { label: 'Bestätigt',     color: 'blue',   sortOrder: 1 },
  picking:    { label: 'Kommissionierung', color: 'orange', sortOrder: 2 },
  picked:     { label: 'Kommissioniert', color: 'purple', sortOrder: 3 },
  packing:    { label: 'Verpackung',    color: 'orange', sortOrder: 4 },
  packed:     { label: 'Verpackt',      color: 'green',  sortOrder: 5 },
  shipped:    { label: 'Versendet',     color: 'green',  sortOrder: 6 },
  delivered:  { label: 'Zugestellt',    color: 'green',  sortOrder: 7 },
  completed:  { label: 'Abgeschlossen', color: 'gray',   sortOrder: 8 },
  cancelled:  { label: 'Storniert',     color: 'red',    sortOrder: 9 },
  returned:   { label: 'Retourniert',   color: 'red',    sortOrder: 10 },
  on_hold:    { label: 'Zurückgestellt', color: 'yellow', sortOrder: 11 },
};

// ─── Allowed Transitions ─────────────────────────────────────

const TRANSITIONS = {
  pending:    ['confirmed', 'picking', 'cancelled', 'on_hold'],
  confirmed:  ['picking', 'cancelled', 'on_hold'],
  picking:    ['picked', 'cancelled', 'on_hold'],
  picked:     ['packing', 'packed', 'cancelled', 'on_hold'],
  packing:    ['packed', 'cancelled', 'on_hold'],
  packed:     ['shipped', 'cancelled', 'on_hold'],
  shipped:    ['delivered', 'returned'],
  delivered:  ['completed', 'returned'],
  completed:  ['returned'],
  cancelled:  ['pending'],  // Re-open cancelled order
  returned:   [],           // Terminal
  on_hold:    ['pending', 'confirmed', 'picking', 'cancelled'],
};

// ─── FORCE_FORBIDDEN_TRANSITIONS (always on, flag-independent) ─────────────
//
// Schmale Negativliste: selbst `force:true` darf KEINE eindeutig-illegale,
// stock-relevante Doppel-/Rueckwaerts-Bewegung ausfuehren. Konservativ
// gehalten — darf bestehende Intake-Flows, die legitim `force:true` nutzen
// (z.B. pending→shipped, shipped→packed, confirmed→shipped), NICHT brechen.
// Blockiert nur:
//   - shipped→shipped: Doppel-Versand → wuerde Doppel-Decrement/Tracking ausloesen.
//   - completed→picking: terminaler Rueckwaerts-Sprung in einen Stock-Schritt.
const FORCE_FORBIDDEN_TRANSITIONS = {
  shipped: ['shipped'],
  completed: ['picking'],
};

/**
 * Pruefen, ob ein Uebergang selbst unter force:true verboten ist.
 * @param {string} fromStatus
 * @param {string} toStatus
 * @returns {boolean}
 */
function isForceForbidden(fromStatus, toStatus) {
  const blocked = FORCE_FORBIDDEN_TRANSITIONS[fromStatus];
  return Array.isArray(blocked) && blocked.includes(toStatus);
}

/**
 * Check if a status transition is allowed.
 * @param {string} fromStatus
 * @param {string} toStatus
 * @returns {boolean}
 */
function isTransitionAllowed(fromStatus, toStatus) {
  const allowed = TRANSITIONS[fromStatus];
  if (!allowed) return false;
  return allowed.includes(toStatus);
}

/**
 * Get all statuses a given status can transition to.
 * @param {string} fromStatus
 * @returns {string[]}
 */
function getNextStatuses(fromStatus) {
  return TRANSITIONS[fromStatus] || [];
}

/**
 * Get status metadata.
 * @param {string} status
 * @returns {{ label: string, color: string, sortOrder: number } | null}
 */
function getStatusInfo(status) {
  return ORDER_STATUSES[status] || null;
}

/**
 * Get all status definitions.
 * @returns {object}
 */
function getAllStatuses() {
  return { ...ORDER_STATUSES };
}

// ─── Status Transition with Event Logging ────────────────────

/**
 * Transition an order to a new status.
 * Validates the transition, updates Firestore, and logs an event.
 *
 * @param {{ tenantId?: string, orderId: string, toStatus: string, actor: { uid: string, email: string }, note?: string }} opts
 * @returns {Promise<{ ok: boolean, fromStatus: string, toStatus: string, error?: string }>}
 */
async function transitionOrder({ tenantId = 'default', orderId, toStatus, actor, note, force = false, timestamps = {} }) {
  if (!orderId) return { ok: false, error: 'orderId ist erforderlich' };
  if (!toStatus) return { ok: false, error: 'toStatus ist erforderlich' };
  if (!ORDER_STATUSES[toStatus]) return { ok: false, error: `Unbekannter Status: ${toStatus}` };

  const db = getDb();
  const orderRef = db.collection(ORDERS_COLLECTION).doc(orderId);

  // Use transaction for atomic read-check-update
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) {
      return { ok: false, error: 'Auftrag nicht gefunden' };
    }

    const order = snap.data();
    const fromStatus = order.omsStatus || order.status || 'pending';

    if (fromStatus === toStatus) {
      return { ok: false, fromStatus, toStatus, error: 'Auftrag ist bereits in diesem Status' };
    }

    // FORCE_FORBIDDEN: selbst force:true darf keinen eindeutig-illegalen,
    // stock-relevanten Doppel-/Rueckwaerts-Move ausfuehren (flag-unabhaengig).
    if (isForceForbidden(fromStatus, toStatus)) {
      return {
        ok: false,
        fromStatus,
        toStatus,
        error: `Übergang von "${ORDER_STATUSES[fromStatus]?.label || fromStatus}" zu "${ORDER_STATUSES[toStatus]?.label || toStatus}" ist auch mit force nicht erlaubt (Stock-Schutz).`,
      };
    }

    // Skip transition validation when force=true (manual override)
    if (!force && !isTransitionAllowed(fromStatus, toStatus)) {
      const allowed = getNextStatuses(fromStatus).map((s) => ORDER_STATUSES[s]?.label || s).join(', ');
      return {
        ok: false,
        fromStatus,
        toStatus,
        error: `Übergang von "${ORDER_STATUSES[fromStatus]?.label || fromStatus}" zu "${ORDER_STATUSES[toStatus]?.label || toStatus}" ist nicht erlaubt. Erlaubt: ${allowed}`,
      };
    }

    // Build update payload
    const update = {
      omsStatus: toStatus,
      omsStatusLabel: ORDER_STATUSES[toStatus].label,
      updatedAt: new Date().toISOString(),
    };

    // Set timestamp fields — caller can pass explicit timestamps, otherwise auto-set
    const now = new Date().toISOString();
    const tsMap = {
      picking: 'pickedAt', picked: 'pickedAt',
      packed: 'packedAt', shipped: 'shippedAt',
      delivered: 'deliveredAt', completed: 'completedAt',
      cancelled: 'cancelledAt',
    };
    const tsField = tsMap[toStatus];
    if (tsField) {
      // Use caller-provided timestamp, or auto-set if not explicitly suppressed
      if (timestamps[tsField] !== undefined) {
        if (timestamps[tsField]) update[tsField] = timestamps[tsField];
        // if null, skip setting (caller explicitly suppressed)
      } else {
        update[tsField] = now;
      }
    }

    // Update order
    tx.set(orderRef, update, { merge: true });

    // Log event
    const eventRef = db.collection(ORDER_EVENTS_COLLECTION).doc();
    tx.set(eventRef, {
      orderId,
      tenantId,
      event: 'status_change',
      fromStatus,
      toStatus,
      fromStatusLabel: ORDER_STATUSES[fromStatus]?.label || fromStatus,
      toStatusLabel: ORDER_STATUSES[toStatus]?.label || toStatus,
      actor: actor ? { uid: actor.uid, email: actor.email } : null,
      note: note || null,
      timestamp: FieldValue.serverTimestamp(),
    });

    return { ok: true, fromStatus, toStatus };
  });

  // Post-transition side effects (fire-and-forget)
  if (result.ok && toStatus === 'shipped') {
    // Auto-generate invoice when order ships (FEAT-ORD-06)
    try {
      const { generateInvoice } = require('./invoice-engine');
      generateInvoice({ orderId, tenantId, actor }).catch((err) => {
        console.warn(`[order-state-machine] Auto-invoice for ${orderId} failed: ${err.message}`);
      });
    } catch (err) {
      console.warn(`[order-state-machine] Auto-invoice import failed: ${err.message}`);
    }

    // Decrement physical stock + sync to all marketplaces (oversell prevention)
    _onOrderShipped({ orderId, tenantId }).catch((err) => {
      console.warn(`[order-state-machine] Stock-out for ${orderId} failed: ${err.message}`);
    });
  }

  if (result.ok && toStatus === 'cancelled') {
    // Release soft-locked stock + (WP4, flag-gated) symmetrische Re-Credit + re-sync marketplaces
    _onOrderCancelled({ orderId, tenantId, fromStatus: result.fromStatus }).catch((err) => {
      console.warn(`[order-state-machine] Stock-release for ${orderId} failed: ${err.message}`);
    });
  }

  if (result.ok && toStatus === 'returned') {
    // WP4 (flag-gated): NEUTRALER Retoure-Pfad. Setzt nur Pending-Grading-Marker,
    // KEIN bookStockIn (Oversell-Guard: defekte Retoure darf sellable nie erhoehen).
    _onOrderReturned({ orderId, tenantId, fromStatus: result.fromStatus }).catch((err) => {
      console.warn(`[order-state-machine] Return-grading marker for ${orderId} failed: ${err.message}`);
    });
  }

  return result;
}

/**
 * On order shipped: confirm reservation + decrement physical stock + push to marketplaces.
 */
async function _onOrderShipped({ orderId, tenantId }) {
  const db = getDb();
  const failures = [];

  // 1. Confirm reservation
  try {
    const { confirmReservation } = require('./stock-reservation');
    const res = await confirmReservation({ tenantId, orderId });
    console.log(`[order-state-machine] confirmReservation orderId=${orderId} confirmed=${res.confirmed}`);
  } catch (err) {
    console.warn(`[order-state-machine] confirmReservation failed orderId=${orderId}: ${err.message}`);
    failures.push({ step: 'confirmReservation', error: err.message });
  }

  // 2. Atomic Claim: Read order + claim stockDecrementedAt in EINER Transaction
  // Verhindert Race Condition: Zwei gleichzeitige Aufrufe koennen nicht beide Phase A betreten.
  // Ein Aufrufer "gewinnt" den Claim und fuehrt Phase A aus, der andere sieht `alreadyDecremented`.
  const orderRef = db.collection(ORDERS_COLLECTION).doc(orderId);
  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(orderRef);
    if (!snap.exists) return { skip: true, reason: 'not_found' };
    const order = snap.data();
    const items = order.items || [];
    if (items.length === 0) return { skip: true, reason: 'no_items' };

    if (order.stockDecrementedAt) {
      return { skip: false, alreadyDecremented: true, items, previousDecrementedAt: order.stockDecrementedAt };
    }

    // Claim atomically — setze Flag JETZT bevor Phase A startet.
    // Wenn Phase A fuer ALLE SKUs fehlschlaegt, wird der Claim am Ende zurueckgesetzt.
    // CLAUDE.md Punkt 13: stockDecrementedBy='ship' markiert diesen Pfad,
    // damit `bookStockOut(meta.orderId)` (Pick-Flow) bei Konflikt erkannt werden kann.
    const skus = items.map((i) => String(i.sku || '').trim()).filter(Boolean);
    tx.update(orderRef, {
      stockDecrementedAt: new Date().toISOString(),
      stockDecrementedBy: 'ship',
      stockDecrementedSkus: skus,
    });
    return { skip: false, alreadyDecremented: false, items };
  });

  if (claim.skip) return;
  const { alreadyDecremented, items } = claim;
  if (alreadyDecremented) {
    // Wer hat geclaimt? Pick-Flow (bookStockOut(meta.orderId)) oder Ship-Flow (frueherer _onOrderShipped-Aufruf)?
    let claimedBy = null;
    try {
      const snap = await orderRef.get();
      if (snap.exists) claimedBy = snap.data()?.stockDecrementedBy || null;
    } catch { /* best-effort */ }
    console.log(
      `[order-state-machine] Stock already decremented for ${orderId} at ${claim.previousDecrementedAt} by='${claimedBy || 'unknown'}' — skipping Phase A, running marketplace sync only (CLAUDE.md Punkt 13)`
    );
  }

  // 3. Build SKU→qty map
  const { syncStockWithRetry } = require('./stock-sync-dispatcher');
  const { decrementProductByIdOrSku } = require('../lib/warehouse');
  const { firestore: fs } = require('../lib/firestore');
  const { withStockLock } = require('../lib/stock-lock');

  const skuQtyMap = {};
  for (const item of items) {
    const sku = String(item.sku || '').trim();
    if (!sku) continue;
    skuQtyMap[sku] = (skuQtyMap[sku] || 0) + (Number(item.quantity) || 1);
  }

  // Phase A — Decrement ALL SKUs first (nur wenn Claim gewonnen)
  if (!alreadyDecremented) {
    for (const [sku, sold] of Object.entries(skuQtyMap)) {
      await withStockLock(sku, async () => {
        try {
          await decrementProductByIdOrSku(sku, sold);
          console.log(`[order-state-machine] stock-out sku=${sku} qty=${sold} (bins + inventory decremented)`);
        } catch (err) {
          console.error(`[order-state-machine] decrementProductByIdOrSku failed sku=${sku}: ${err.message}`);
          failures.push({ step: 'decrement', sku, qty: sold, error: err.message });
        }
      });
    }

    // Rollback: Wenn ALLE Decrements fehlgeschlagen sind, Claim zuruecksetzen damit Retry moeglich ist.
    // Wenn mindestens 1 SKU erfolgreich war, bleibt der Claim bestehen (Teil-Erfolg = Flag bleibt).
    const decrementFailures = failures.filter((f) => f.step === 'decrement');
    const totalSkus = Object.keys(skuQtyMap).length;
    if (totalSkus > 0 && decrementFailures.length === totalSkus) {
      try {
        await orderRef.update({
          stockDecrementedAt: FieldValue.delete(),
          stockDecrementedSkus: FieldValue.delete(),
        });
        console.warn(`[order-state-machine] All ${totalSkus} decrements failed for ${orderId} — claim released for retry`);
      } catch (rollbackErr) {
        console.error(`[order-state-machine] Failed to release claim after total failure for ${orderId}: ${rollbackErr.message}`);
      }
    }
  }

  // Phase B — THEN sync all SKUs to marketplaces (reads post-decrement data, runs ALWAYS)
  for (const sku of Object.keys(skuQtyMap)) {
    try {
      let snap = await fs.collection('products_v2')
        .where('identification.sku', '==', sku)
        .limit(1)
        .get();
      if (snap.empty) {
        snap = await fs.collection('products_v2')
          .where('details.identifiers.sku', '==', sku)
          .limit(1)
          .get();
      }
      if (!snap.empty) {
        const doc = snap.docs[0];
        const product = { id: doc.id, ...doc.data() };
        const syncResult = await syncStockWithRetry({ tenantId, product, reason: `shipped-${orderId}` });
        const channelErrors = Array.isArray(syncResult?.results)
          ? syncResult.results.filter((c) => c && (c.status === 'error' || c.status === 'failed'))
          : [];
        for (const ch of channelErrors) {
          failures.push({
            step: 'marketplaceSync',
            sku,
            channel: ch.channel || null,
            error: ch.error || `status:${ch.status || 'unknown'}`,
          });
        }
      }
    } catch (err) {
      console.warn(`[order-state-machine] marketplace sync failed sku=${sku}: ${err.message}`);
      failures.push({ step: 'marketplaceSync', sku, error: err.message });
    }
  }

  // Persist failures for recovery
  if (failures.length > 0) {
    try {
      await db.collection('stock_operation_failures').add({
        tenantId,
        orderId,
        operation: 'shipped',
        failures,
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      console.error(`[order-state-machine] ${failures.length} stock failures for ${orderId} persisted to stock_operation_failures`);
    } catch (persistErr) {
      console.error(`[order-state-machine] CRITICAL: Failed to persist stock failures for ${orderId}:`, persistErr.message);
    }
  }
}

/**
 * Look up a products_v2 doc by SKU (identification.sku → details.identifiers.sku fallback).
 * @returns {Promise<object|null>} { id, ...data } or null
 */
async function _findProductBySku(sku, tenantId) {
  const { firestore: fs } = require('../lib/firestore');
  let snap = await fs.collection('products_v2')
    .where('identification.sku', '==', sku)
    .limit(1)
    .get();
  if (snap.empty) {
    snap = await fs.collection('products_v2')
      .where('details.identifiers.sku', '==', sku)
      .limit(1)
      .get();
  }
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

/**
 * Resolve a re-credit BIN for a product: storage.binCode → first storageBin → fallback ENV.
 * @returns {string|null}
 */
function _resolveRecreditBin(product) {
  return (
    product?.storage?.binCode
    || (Array.isArray(product?.storageBins) && product.storageBins[0]?.code)
    || recreditFallbackBin()
  );
}

/**
 * WP4 — symmetrische Bestands-Gutschrift fuer eine dekrementierte Order.
 *
 * Spiegelt die Phase-A-Logik aus `_onOrderShipped`: claim (idempotent),
 * pro SKU bookStockIn unter withStockLock, bei Total-Failure Claim-Rollback +
 * stock_operation_failures fuer den Drain.
 *
 * Wird NUR aufgerufen wenn `mode != 'false'`. In 'shadow' nur resolve + log.
 * NIE fuer den Retoure-Pfad (defekte Retoure → kein Auto-Credit).
 *
 * @param {object} args
 * @param {string} args.orderId
 * @param {string} args.tenantId
 * @param {'cancel'|'label-cancel'} args.by
 * @param {string} args.mode  recreditMode()
 * @param {boolean} [args.clearDecrementMarker]  bei label-cancel: Decrement-Marker loeschen (Re-Ship-fähig)
 * @returns {Promise<{ credited: number, skipped: string|null }>}
 */
async function _recreditOrderStock({ orderId, tenantId, by, mode, clearDecrementMarker = false }) {
  const db = getDb();
  const orderRef = db.collection(ORDERS_COLLECTION).doc(orderId);
  const { claimOrderStockRecreditInTx } = require('../lib/order-stock-recredit-claim');

  // Order lesen (fuer items + decrement-skus).
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) return { credited: 0, skipped: 'order-not-found' };
  const order = orderSnap.data();
  const decrementedSkus = Array.isArray(order.stockDecrementedSkus)
    ? order.stockDecrementedSkus.map(String)
    : [];
  const items = order.items || [];

  // SKU→qty NUR fuer Skus die tatsaechlich dekrementiert wurden (NIE phantom-credit).
  const skuQtyMap = {};
  for (const item of items) {
    const sku = String(item.sku || '').trim();
    if (!sku || !decrementedSkus.includes(sku)) continue;
    skuQtyMap[sku] = (skuQtyMap[sku] || 0) + (Number(item.quantity) || 1);
  }
  const skus = Object.keys(skuQtyMap);

  // ── SHADOW: nur entscheiden + loggen, KEINE Mutation ──
  if (mode === 'shadow') {
    // Idempotency-Gates ohne Write nachbilden, damit das Log die echte Entscheidung spiegelt.
    if (!order.stockDecrementedAt) {
      console.log(`[recredit-shadow] order=${orderId} by=${by} skip=never-decremented`);
      return { credited: 0, skipped: 'never-decremented' };
    }
    if (order.stockRecreditedAt) {
      console.log(`[recredit-shadow] order=${orderId} by=${by} skip=already-recredited`);
      return { credited: 0, skipped: 'already-recredited' };
    }
    for (const [sku, qty] of Object.entries(skuQtyMap)) {
      let bin = null;
      try {
        const product = await _findProductBySku(sku, tenantId);
        bin = _resolveRecreditBin(product);
      } catch { /* best-effort in shadow */ }
      console.log(`[recredit-shadow] order=${orderId} would bookStockIn sku=${sku} qty=${qty} bin=${bin || 'none'}`);
    }
    return { credited: 0, skipped: 'shadow' };
  }

  // ── REAL: atomarer Claim (idempotent check-and-set) ──
  const claim = await db.runTransaction(async (tx) => {
    return claimOrderStockRecreditInTx({ tx, orderRef, by, skus });
  });
  if (!claim.claimed) {
    // never-decremented | already-recredited | order-not-found → kein Credit.
    return { credited: 0, skipped: claim.alreadyRecredited ? 'already-recredited' : (claim.reason || 'not-claimed') };
  }

  // Claim gewonnen → pro SKU bookStockIn unter withStockLock.
  const { bookStockIn } = require('../lib/warehouse');
  const { withStockLock } = require('../lib/stock-lock');
  const failures = [];
  let credited = 0;

  for (const [sku, qty] of Object.entries(skuQtyMap)) {
    await withStockLock(sku, async () => {
      let bin = null;
      try {
        const product = await _findProductBySku(sku, tenantId);
        bin = _resolveRecreditBin(product);
        if (!bin) {
          throw new Error('no_known_bin');
        }
        await bookStockIn({
          productId: product?.id,
          sku,
          binCode: bin,
          quantity: qty,
          meta: { source: `${by}-recredit`, orderId },
        });
        credited++;
        console.log(`[order-state-machine] re-credit sku=${sku} qty=${qty} → BIN ${bin} (${by} ${orderId})`);
      } catch (err) {
        console.error(`[order-state-machine] re-credit bookStockIn failed sku=${sku}: ${err.message}`);
        // Per-SKU Failure-Record (binCode kann null sein, falls Bin-Resolve scheiterte).
        failures.push({ step: 'recredit', sku, qty, binCode: bin || null, error: err.message });
      }
    });
  }

  // ── Durability-Handling für gescheiterte Credits ───────────────────────────
  //
  // INVARIANT: kein gescheiterter SKU darf still verloren gehen (under-credit =
  // sichere Richtung, aber MUSS durable + recoverable bleiben). Es gibt zwei Fälle:
  //
  //  (A) ALL-FAIL (failures == totalSkus): kein einziger Credit lief durch.
  //      → Claim-Marker zurückrollen, damit ein erneuter cancel/return-Event den
  //        kompletten Re-Credit sauber neu claimen kann. Plus per-SKU Failure-Docs.
  //
  //  (B) PARTIAL-FAIL (0 < failures < totalSkus): mind. ein Credit lief durch.
  //      → Claim-Marker BLEIBT gesetzt (die erfolgreichen Credits sind passiert;
  //        ein erneuter cancel würde sonst via never/already-Gate die bereits
  //        gutgeschriebenen SKUs DOPPELT crediten — Over-Credit). Nur die
  //        gescheiterten SKUs werden einzeln gequeued.
  //
  // Jedes gescheiterte SKU wird als EIGENES Failure-Doc persistiert (sku +
  // orderId + qty + binCode), gespiegelt am Per-SKU-Pattern in _onOrderShipped.
  // Der generische Marketplace-Drain (services/stock-failure-drain.js) führt
  // `bookStockIn` NICHT selbst aus — `step:'recredit'` ist daher KEIN auto-retry-
  // barer marketplaceSync-Step. Damit der Drain solche Docs NICHT fälschlich als
  // `resolved` markiert (er würde sonst die Recovery-Spur löschen), tragen sie
  // zusätzlich einen `step:'decrement'`-Manual-Marker: der Drain routet sie so zu
  // `needs_manual` inkl. Operator-Alert. Re-Credit ist pro SKU manuell/idempotent
  // recoverbar — under-credit-until-manual ist die bewusst gewählte sichere
  // Richtung (NIE over-credit). Siehe Single-Writer-Invariant (CLAUDE.md Punkt 13).
  const totalSkus = skus.length;
  const allFailed = totalSkus > 0 && failures.length === totalSkus;

  if (allFailed) {
    // (A) Rollback nur wenn NULL SKUs erfolgreich waren → vollständiger Retry möglich.
    try {
      await orderRef.update({
        stockRecreditedAt: FieldValue.delete(),
        stockRecreditedBy: FieldValue.delete(),
        stockRecreditedSkus: FieldValue.delete(),
      });
      console.warn(`[order-state-machine] All ${totalSkus} re-credits failed for ${orderId} — claim released for retry`);
    } catch (rollbackErr) {
      console.error(`[order-state-machine] Failed to release re-credit claim for ${orderId}: ${rollbackErr.message}`);
    }
  } else if (failures.length > 0) {
    // (B) Teil-Erfolg: Claim-Marker BLEIBT gesetzt (Over-Credit-Schutz für die
    // bereits gutgeschriebenen SKUs). Nur die gescheiterten SKUs werden gequeued.
    console.warn(`[order-state-machine] Partial re-credit for ${orderId}: ${credited}/${totalSkus} credited, ${failures.length} failed — marker kept, failed SKUs queued individually`);
  }

  // Per-SKU Failure-Docs persistieren (gilt für ALL-FAIL und PARTIAL-FAIL gleich).
  if (failures.length > 0) {
    await _persistRecreditFailures({ db, tenantId, orderId, by, failures });
  }

  if (allFailed) {
    return { credited: 0, skipped: 'all-failed' };
  }

  // Bei label-cancel: Decrement-Marker loeschen, damit ein spaeteres Re-Ship korrekt decrementiert.
  if (clearDecrementMarker && credited > 0) {
    try {
      await orderRef.update({
        stockDecrementedAt: FieldValue.delete(),
        stockDecrementedBy: FieldValue.delete(),
        stockDecrementedSkus: FieldValue.delete(),
      });
    } catch (err) {
      console.warn(`[order-state-machine] Failed to clear decrement marker after label-cancel for ${orderId}: ${err.message}`);
    }
  }

  return { credited, skipped: null };
}

/**
 * Persistiert gescheiterte Re-Credit-Buchungen als EINZELNE, durable, per-SKU
 * Failure-Docs in `stock_operation_failures` — gespiegelt am Per-SKU-Pattern in
 * `_onOrderShipped`. Verhindert den Silent-Drop bei Partial-Multi-SKU-Failures.
 *
 * Jedes Doc enthält die explizite `sku` (+ orderId, qty, binCode), sodass eine
 * spätere Recovery EXAKT diesen einen SKU adressiert und NIE einen bereits
 * erfolgreich gecrediteten SKU erneut bucht (kein Over-Credit).
 *
 * Drain-Routing: der generische Marketplace-Drain führt `bookStockIn` nicht
 * selbst aus. Ein reiner `step:'recredit'`-Eintrag würde dort fälschlich als
 * `resolved` markiert (Recovery-Spur verloren). Deshalb trägt jedes Doc
 * zusätzlich einen `step:'decrement'`-Marker → der Drain routet es zu
 * `needs_manual` + Operator-Alert statt es zu false-resolven. Re-Credit bleibt
 * damit durable + sichtbar; der Operator schreibt den fehlenden Bestand
 * manuell/idempotent zurück. Under-credit-until-manual ist die bewusst gewählte
 * sichere Richtung (NIE over-credit).
 *
 * Best-effort: ein fehlgeschlagener Persist-Versuch eines SKU darf die übrigen
 * nicht blockieren.
 *
 * @param {object} args
 * @param {Firestore} args.db
 * @param {string} args.tenantId
 * @param {string} args.orderId
 * @param {'cancel'|'return'|'label-cancel'} args.by
 * @param {Array<{ sku: string, qty: number, binCode: string|null, error: string }>} args.failures
 */
async function _persistRecreditFailures({ db, tenantId, orderId, by, failures }) {
  for (const f of failures) {
    try {
      await db.collection('stock_operation_failures').add({
        tenantId,
        orderId,
        operation: `${by}-recredit`,
        sku: f.sku,
        qty: f.qty,
        binCode: f.binCode || null,
        // `recredit` = präzise Beschreibung; `decrement` = Drain-Routing zu
        // needs_manual (siehe stock-failure-drain.js, der bookStockIn nicht ausführt).
        failures: [
          { step: 'recredit', sku: f.sku, qty: f.qty, binCode: f.binCode || null, error: f.error },
          { step: 'decrement', sku: f.sku, qty: f.qty, error: `recredit-requires-manual: ${f.error}` },
        ],
        requiresManual: true,
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      console.error(`[order-state-machine] re-credit failure for ${orderId} sku=${f.sku} persisted to stock_operation_failures (operation=${by}-recredit)`);
    } catch (persistErr) {
      console.error(`[order-state-machine] CRITICAL: Failed to persist re-credit failure for ${orderId} sku=${f.sku}:`, persistErr.message);
    }
  }
}

/**
 * Re-sync available stock for all SKUs of an order to marketplaces (best-effort).
 */
async function _resyncOrderStock({ orderId, tenantId, reasonPrefix }) {
  const db = getDb();
  const orderDoc = await db.collection(ORDERS_COLLECTION).doc(orderId).get();
  if (!orderDoc.exists) return;
  const order = orderDoc.data();
  const items = order.items || [];
  const skus = [...new Set(items.map((i) => String(i.sku || '').trim()).filter(Boolean))];
  if (skus.length === 0) return;

  const { syncStockWithRetry } = require('./stock-sync-dispatcher');
  for (const sku of skus) {
    try {
      const product = await _findProductBySku(sku, tenantId);
      if (product) {
        syncStockWithRetry({ tenantId, product, reason: `${reasonPrefix}-${orderId}` })
          .catch((err) => console.warn(`[order-state-machine] channel sync failed ${reasonPrefix} sku=${sku}: ${err.message}`));
      }
    } catch (err) {
      console.warn(`[order-state-machine] ${reasonPrefix} sync lookup failed sku=${sku}: ${err.message}`);
    }
  }
}

/**
 * On order cancelled: release reservation + (WP4, flag-gated) symmetric re-credit
 * + re-sync available stock to marketplaces.
 *
 * @param {{ orderId: string, tenantId: string, fromStatus?: string }} opts
 */
async function _onOrderCancelled({ orderId, tenantId, fromStatus }) {
  // 1) Release the soft-lock (ALWAYS — heutiges Verhalten unveraendert).
  try {
    const { releaseReservation } = require('./stock-reservation');
    const res = await releaseReservation({ tenantId, orderId });
    console.log(`[order-state-machine] releaseReservation orderId=${orderId} released=${res.released}`);
  } catch (err) {
    console.warn(`[order-state-machine] releaseReservation failed orderId=${orderId}: ${err.message}`);
  }

  // 2) WP4 (flag-gated): symmetrische Bestands-Gutschrift fuer dekrementierte Orders.
  const mode = recreditMode();
  if (mode !== 'false') {
    try {
      await _recreditOrderStock({ orderId, tenantId, by: 'cancel', mode });
    } catch (err) {
      console.error(`[order-state-machine] re-credit on cancel failed for ${orderId}: ${err.message}`);
    }
  }

  // 3) Re-sync stock to marketplaces (available qty just increased due to release).
  await _resyncOrderStock({ orderId, tenantId, reasonPrefix: 'cancelled' });
}

/**
 * On order returned (WP4, NEW + flag-gated): NEUTRALER Pfad.
 *
 * CRITICAL Oversell-Guard: dieser Handler ruft NIEMALS bookStockIn und erhoeht
 * NIEMALS sellable stock. Eine Retoure kann defekt (B/C-Ware) sein → der
 * tatsaechliche Re-Credit passiert ERST beim Operator-Grading (returns-engine).
 *
 * Er setzt nur:
 *   (a) additiven, neutralen Marker stockReturnPendingGradingAt
 *       (stockDecrementedAt bleibt SET, kein stockRecreditedAt),
 *   (b) stellt sicher, dass ein returns/{…}-Doc fuer die Order existiert,
 *       damit ein Operator graden kann,
 *   (c) KEIN Marketplace-Resync (sellable qty unveraendert).
 *
 * @param {{ orderId: string, tenantId: string, fromStatus?: string }} opts
 */
async function _onOrderReturned({ orderId, tenantId, fromStatus }) {
  const mode = recreditMode();
  if (mode === 'false') return; // INERT bei flag off.

  const db = getDb();
  const orderRef = db.collection(ORDERS_COLLECTION).doc(orderId);

  // (a) neutraler Pending-Grading-Marker (shadow → nur Log).
  if (mode === 'shadow') {
    console.log(`[recredit-shadow] order=${orderId} by=return would set stockReturnPendingGradingAt (NO bookStockIn)`);
  } else {
    try {
      await orderRef.update({ stockReturnPendingGradingAt: new Date().toISOString() });
    } catch (err) {
      console.warn(`[order-state-machine] Failed to set pending-grading marker for ${orderId}: ${err.message}`);
    }
  }

  // (b) returns-Doc sicherstellen (Operator kann graden).
  try {
    const existing = await db.collection('returns')
      .where('orderId', '==', orderId)
      .limit(1)
      .get();
    if (existing.empty) {
      const orderSnap = await orderRef.get();
      const order = orderSnap.exists ? orderSnap.data() : {};
      const firstItem = (order.items || [])[0] || {};
      const minimalReturn = {
        tenantId,
        orderId,
        marketplace: order.marketplace || null,
        marketplaceOrderId: order.marketplaceOrderId || null,
        product: { name: firstItem.name || null, sku: firstItem.sku || null, quantity: firstItem.quantity || 1 },
        reason: 'sonstiges',
        reasonRaw: 'order-returned-transition',
        status: 'eingegangen',
        orderAmount: order.totalAmount || 0,
        createdAt: new Date().toISOString(),
        source: 'order-state-machine:returned',
      };
      if (mode === 'shadow') {
        console.log(`[recredit-shadow] order=${orderId} would create returns doc for grading`);
      } else {
        await db.collection('returns').add(minimalReturn);
      }
    }
  } catch (err) {
    console.warn(`[order-state-machine] Failed to ensure returns doc for ${orderId}: ${err.message}`);
  }

  // (c) KEIN Marketplace-Resync — sellable qty unveraendert (Oversell-Guard).
}

/**
 * On shipping-label cancelled (shipped → packed), WP4 flag-gated.
 *
 * Wenn die Order beim Versand dekrementiert wurde, MUSS der Bestand wieder
 * gutgeschrieben werden — UND der Decrement-Marker geloescht werden, damit ein
 * spaeteres Re-Ship korrekt erneut decrementiert. by:'label-cancel'.
 *
 * @param {{ orderId: string, tenantId: string, fromStatus?: string }} opts
 */
async function _onLabelCancelled({ orderId, tenantId, fromStatus }) {
  const mode = recreditMode();
  if (mode === 'false') return; // INERT bei flag off (heutiges No-Op-Verhalten).
  if (fromStatus && fromStatus !== 'shipped') return; // nur shipped → packed re-credited.

  try {
    await _recreditOrderStock({ orderId, tenantId, by: 'label-cancel', mode, clearDecrementMarker: true });
  } catch (err) {
    console.error(`[order-state-machine] re-credit on label-cancel failed for ${orderId}: ${err.message}`);
  }
}

/**
 * Get the event history (timeline) for an order.
 * @param {{ orderId: string, limit?: number }} opts
 * @returns {Promise<object[]>}
 */
async function getOrderTimeline({ orderId, limit = 50 }) {
  const snap = await getDb()
    .collection(ORDER_EVENTS_COLLECTION)
    .where('orderId', '==', orderId)
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .get();

  return snap.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      event: d.event,
      fromStatus: d.fromStatus,
      toStatus: d.toStatus,
      fromStatusLabel: d.fromStatusLabel,
      toStatusLabel: d.toStatusLabel,
      actor: d.actor,
      note: d.note,
      timestamp: d.timestamp?.toDate?.()?.toISOString() || d.timestamp || null,
    };
  });
}

/**
 * Get order counts grouped by OMS status.
 * @param {{ tenantId?: string }} opts
 * @returns {Promise<Record<string, number>>}
 */
async function getStatusCounts({ tenantId = 'default' } = {}) {
  // Firestore doesn't support GROUP BY — we query all and count client-side
  const snap = await getDb()
    .collection(ORDERS_COLLECTION)
    .where('tenantId', '==', tenantId)
    .select('omsStatus', 'status')
    .limit(5000)
    .get();

  const counts = {};
  for (const status of Object.keys(ORDER_STATUSES)) {
    counts[status] = 0;
  }

  for (const doc of snap.docs) {
    const d = doc.data();
    const status = d.omsStatus || d.status || 'pending';
    const mapped = mapLegacyStatus(status);
    counts[mapped] = (counts[mapped] || 0) + 1;
  }

  return counts;
}

/**
 * Map legacy status to OMS status.
 * @param {string} status
 * @returns {string}
 */
function mapLegacyStatus(status) {
  const legacyMap = {
    new: 'pending',
    picking: 'picking',
    picked: 'picked',
    packed: 'packed',
    other: 'pending',
  };
  return legacyMap[status] || (ORDER_STATUSES[status] ? status : 'pending');
}

module.exports = {
  ORDER_STATUSES,
  TRANSITIONS,
  FORCE_FORBIDDEN_TRANSITIONS,
  isTransitionAllowed,
  isForceForbidden,
  getNextStatuses,
  getStatusInfo,
  getAllStatuses,
  transitionOrder,
  processShippedOrder: _onOrderShipped,
  processCancelledOrder: _onOrderCancelled,
  processReturnedOrder: _onOrderReturned,
  processLabelCancelled: _onLabelCancelled,
  recreditMode,
  getOrderTimeline,
  getStatusCounts,
  mapLegacyStatus,
};
