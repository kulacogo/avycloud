/**
 * stock-core.js — WP3 / F1 ledger foundation (READ-SIDE / SHADOW first).
 *
 * Bestands-Wahrheit ist `warehouseEvents` (append-only): `onHand = Σ delta`.
 * `products_v2.inventory.quantity` ist die abgeglichene PROJEKTION, nie die
 * Wahrheit. Dieses Modul liefert zunächst die REINEN, read-only Bausteine, die
 * der Shadow-/Reconcile-Lauf braucht (das Tor vor dem `STOCK_LEDGER`-Cutover):
 *   - computeOnHandFromEvents  : Σ der signierten Deltas
 *   - computeAvailableToSell   : max(0, onHand − allocated) — nie negativ
 *   - buildMovementEventId     : deterministische Event-Doc-ID für Idempotenz
 *   - reconcileLedger          : vergleicht Projektion vs. Ledger, MELDET Drift
 *                                (heilt nie still — CLAUDE.md, F1-Invariante)
 *
 * Der Schreiber `applyMovement(movement)` und der eigentliche Cutover
 * (`STOCK_LEDGER`/`STOCK_LEDGER_SHADOW`) folgen als separater, owner-gated
 * Schritt mit Shadow-Choreografie (Master-Plan WP3 / Execution-Guide §5).
 */

'use strict';

const crypto = require('crypto');

/**
 * onHand = Σ warehouseEvents.delta. Nicht-numerische Deltas zählen als 0 (nie NaN).
 * @param {Array<{delta:number}>} events
 * @returns {number}
 */
function computeOnHandFromEvents(events) {
  if (!Array.isArray(events)) return 0;
  let sum = 0;
  for (const e of events) {
    const d = Number(e && e.delta);
    if (Number.isFinite(d)) sum += d;
  }
  return sum;
}

/**
 * availableToSell = max(0, onHand − allocated). An Marktplätze geht IMMER dieser
 * Wert. Wird an EINER Stelle berechnet, damit Kanäle nie „onHand" sehen.
 * @param {{onHand?:number, allocated?:number}} params
 * @returns {number}
 */
function computeAvailableToSell({ onHand = 0, allocated = 0 } = {}) {
  const oh = Number.isFinite(Number(onHand)) ? Number(onHand) : 0;
  const al = Number.isFinite(Number(allocated)) ? Number(allocated) : 0;
  return Math.max(0, oh - al);
}

/**
 * Deterministische Event-Doc-ID `sha1(tenantId|idempotencyKey)`. Gleicher Key →
 * gleiche ID → die Append-Tx ist idempotent (kein Doppel-Decrement). Der Key
 * MUSS explizit sein — Idempotenz darf nie geraten werden.
 * @param {{tenantId?:string, idempotencyKey:string}} params
 * @returns {string} sha1 hex (40 chars)
 */
function buildMovementEventId({ tenantId = 'default', idempotencyKey } = {}) {
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw new Error('buildMovementEventId: idempotencyKey (string) is required');
  }
  return crypto.createHash('sha1').update(`${tenantId}|${idempotencyKey}`).digest('hex');
}

/**
 * Vergleicht die Projektion (`products_v2.inventory.quantity`) gegen Σ Ledger.
 * MELDET die Differenz — heilt NIE still (eine Abweichung ist ein Signal, kein
 * Bug, der überschrieben wird). Mutiert die Eingaben nicht.
 * @param {{events?:Array, projectionOnHand?:number}} params
 * @returns {{inSync:boolean, diff:number, ledgerOnHand:number, projectionOnHand:number}}
 */
function reconcileLedger({ events = [], projectionOnHand = 0 } = {}) {
  const ledgerOnHand = computeOnHandFromEvents(events);
  const projection = Number.isFinite(Number(projectionOnHand)) ? Number(projectionOnHand) : 0;
  const diff = projection - ledgerOnHand; // signed: + = projection ahead, − = behind
  return {
    inSync: diff === 0,
    diff,
    ledgerOnHand,
    projectionOnHand: projection,
  };
}

/**
 * applyMovement — der EINZIGE Schreiber (WP3, „dunkel" gebaut, noch nicht in
 * transitionOrder verdrahtet). Eine Firestore-Tx unter withStockLock:
 *   validieren → Idempotenz über deterministische Event-Doc-ID → Event anhängen
 *   → Projektion fortschreiben (onHand += delta, availableToSell, nie negativ).
 * Nach Commit best-effort notifyStockChange + emitSyncEvent (F0-Enqueue),
 * sofern als deps übergeben.
 *
 * Abhängigkeiten werden injiziert (firestore, withStockLock, now, optional
 * notifyStockChange/emitSyncEvent) → voll testbar ohne echte Infrastruktur.
 *
 * @returns {Promise<{applied:boolean, eventId:string, reason?:string, onHand?:number, availableToSell?:number}>}
 */
async function applyMovement(movement, deps = {}) {
  const { tenantId = 'default', productId, delta, type = 'adjust', idempotencyKey, meta = null } = movement || {};
  const { firestore, withStockLock, now = Date.now(), notifyStockChange, emitSyncEvent } = deps;

  if (!firestore) throw new Error('applyMovement: firestore dependency required');
  if (!productId) throw new Error('applyMovement: productId required');
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw new Error('applyMovement: idempotencyKey (string) required');
  }
  const d = Number(delta);
  if (!Number.isFinite(d)) throw new Error('applyMovement: numeric delta required');

  const lock = typeof withStockLock === 'function' ? withStockLock : (_k, fn) => fn();
  const eventId = buildMovementEventId({ tenantId, idempotencyKey });

  const result = await lock(`stock:${productId}`, () => firestore.runTransaction(async (tx) => {
    const eventRef = firestore.collection('warehouseEvents').doc(eventId);
    const existing = await tx.get(eventRef);
    if (existing && existing.exists) {
      return { applied: false, reason: 'duplicate', eventId };
    }

    const productRef = firestore.collection('products_v2').doc(productId);
    const prodSnap = await tx.get(productRef);
    const prod = prodSnap && prodSnap.exists ? (prodSnap.data() || {}) : {};
    const inv = prod.inventory || {};
    const currentOnHand = Number(inv.onHand ?? inv.quantity ?? 0) || 0;
    const reserved = Number(inv.reserved ?? 0) || 0;
    const newOnHand = currentOnHand + d;
    if (newOnHand < 0) {
      throw new Error(`applyMovement: refusing to drive onHand negative (current=${currentOnHand}, delta=${d}) for ${productId}`);
    }
    const availableToSell = computeAvailableToSell({ onHand: newOnHand, allocated: reserved });

    tx.set(eventRef, {
      type,
      tenantId,
      productId,
      delta: d,
      quantityAfter: newOnHand,
      idempotencyKey,
      meta,
      createdAt: new Date(now).toISOString(),
    });
    // Whole-inventory merge keeps unrelated sub-fields; quantity stays an alias of onHand.
    tx.update(productRef, { inventory: { ...inv, onHand: newOnHand, quantity: newOnHand, reserved, availableToSell } });

    return { applied: true, eventId, onHand: newOnHand, availableToSell };
  }));

  // Best-effort post-commit fan-out (never throws — telemetry/sync must not break the write).
  if (result && result.applied) {
    if (typeof notifyStockChange === 'function') {
      try { await notifyStockChange({ tenantId, productId, delta: d, onHand: result.onHand }); } catch (_) { /* best-effort */ }
    }
    if (typeof emitSyncEvent === 'function') {
      try { emitSyncEvent('stock:changed', { tenantId, productId, onHand: result.onHand }); } catch (_) { /* best-effort */ }
    }
  }
  return result;
}

// WP3 cutover flag. default OFF → projection sourced from warehouseBins (today).
// ON → refreshProductInventory sources inventory.quantity from the ledger (Σ events).
function stockLedgerEnabled() {
  return String(process.env.STOCK_LEDGER || '').toLowerCase() === 'true';
}

/**
 * Σ warehouseEvents.delta for one product (the ledger onHand). Throws on read
 * error so the caller can decide to fall back to bins (never a silent 0).
 * @param {{productId:string, firestore?:object}} params
 * @returns {Promise<number>}
 */
async function sumProductLedger({ productId, firestore } = {}) {
  if (!productId) throw new Error('sumProductLedger: productId required');
  const db = firestore || require('./firestore').firestore;
  const snap = await db.collection('warehouseEvents').where('productId', '==', productId).select('delta').get();
  let sum = 0;
  snap.forEach((d) => {
    const x = Number(d.data() && d.data().delta);
    if (Number.isFinite(x)) sum += x;
  });
  return sum;
}

module.exports = {
  computeOnHandFromEvents,
  computeAvailableToSell,
  buildMovementEventId,
  reconcileLedger,
  applyMovement,
  sumProductLedger,
  stockLedgerEnabled,
};
