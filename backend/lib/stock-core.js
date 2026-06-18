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

module.exports = {
  computeOnHandFromEvents,
  computeAvailableToSell,
  buildMovementEventId,
  reconcileLedger,
};
