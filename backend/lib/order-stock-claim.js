/**
 * Order-Stock-Decrement-Claim — zentraler Idempotency-Marker.
 *
 * Siehe CLAUDE.md Punkt 13 (Stock Single Writer Invariant) und
 * docs/architecture/stock-single-source-of-truth.md.
 *
 * Es gibt zwei legitime Decrement-Pfade fuer eine Order-Einheit:
 *   A) `bookStockOut(meta.orderId=…)` (Pick-with-Order)
 *   B) `_onOrderShipped → decrementProductByIdOrSku` (Ship-Decrement)
 *
 * Beide MUESSEN denselben atomaren Marker auf `orders/{orderId}` setzen,
 * damit der jeweils andere Pfad seinen Decrement skipped:
 *   { stockDecrementedAt: ISO,
 *     stockDecrementedBy: 'pick' | 'ship',
 *     stockDecrementedSkus: [sku, ...] }
 *
 * Diese Datei stellt zwei phasen-getrennte Helper bereit, damit Aufrufer,
 * die in derselben Tx bereits andere Reads/Writes ausfuehren, die Firestore-
 * Read-before-Write-Regel nicht verletzen:
 *
 *   • `readOrderClaimStateInTx({tx, orderRef})`
 *       Reine LESE-Phase. MUSS vor dem ersten Write im Tx aufgerufen werden.
 *
 *   • `writeOrderClaimInTx({tx, orderRef, by, skus, nowIso})`
 *       Reine SCHREIB-Phase. MUSS nach allen Reads aufgerufen werden.
 *
 *   • `claimOrderStockDecrementInTx({tx, orderRef, by, skus, nowIso})`
 *       Backward-compatibler Komfort-Wrapper, der Read+Write in einem Aufruf
 *       kombiniert. Nur sicher, wenn der Tx-Aufrufer noch keine Writes
 *       gemacht hat. Sonst Firestore-Fehler:
 *       "Firestore transactions require all reads to be executed before all writes."
 *
 * (Ausnahme fuer Marker-Loeschung: Rollback-Path via `FieldValue.delete()`
 *  in `services/order-state-machine.js`.)
 */

'use strict';

function _validateTx(tx) {
  if (!tx || typeof tx.get !== 'function' || typeof tx.update !== 'function') {
    throw new Error('order-stock-claim: invalid tx');
  }
}

function _validateBy(by) {
  if (by !== 'pick' && by !== 'ship') {
    throw new Error(`order-stock-claim: invalid by="${by}" (must be 'pick' | 'ship')`);
  }
}

/**
 * Phase 1 — reine Lese-Phase.
 * Liest den aktuellen Claim-Zustand der Order. Macht KEINE Writes.
 * Sicher in jeder Tx, solange noch kein Write erfolgt ist.
 *
 * @param {object} args
 * @param {FirestoreTransaction} args.tx
 * @param {DocumentReference} args.orderRef
 * @returns {Promise<{
 *   exists: boolean,
 *   alreadyClaimed: boolean,
 *   at: string|null,
 *   by: 'pick'|'ship'|null,
 *   skus: string[]
 * }>}
 */
async function readOrderClaimStateInTx({ tx, orderRef } = {}) {
  _validateTx(tx);
  if (!orderRef) throw new Error('order-stock-claim: orderRef missing');

  const snap = await tx.get(orderRef);
  if (!snap || !snap.exists) {
    return { exists: false, alreadyClaimed: false, at: null, by: null, skus: [] };
  }
  const data = (snap.data && snap.data()) || {};
  const at = data.stockDecrementedAt || null;
  const by = data.stockDecrementedBy || null;
  const skus = Array.isArray(data.stockDecrementedSkus) ? data.stockDecrementedSkus.map(String) : [];
  return {
    exists: true,
    alreadyClaimed: Boolean(at),
    at,
    by: by === 'pick' || by === 'ship' ? by : null,
    skus,
  };
}

/**
 * Phase 2 — reine Schreib-Phase.
 * Setzt den Claim-Marker. Macht NUR `tx.update`. Aufrufer muss vorher mit
 * `readOrderClaimStateInTx` verifiziert haben, dass die Order existiert
 * und noch nicht geclaimt ist.
 *
 * @param {object} args
 * @param {FirestoreTransaction} args.tx
 * @param {DocumentReference} args.orderRef
 * @param {'pick'|'ship'} args.by
 * @param {string[]} [args.skus]
 * @param {string} [args.nowIso]
 * @returns {{claimed: true, at: string, by: 'pick'|'ship', skus: string[]}}
 */
function writeOrderClaimInTx({ tx, orderRef, by, skus, nowIso } = {}) {
  _validateTx(tx);
  if (!orderRef) throw new Error('order-stock-claim: orderRef missing');
  _validateBy(by);

  const claimedAt = nowIso || new Date().toISOString();
  const skuList = Array.isArray(skus) ? skus.filter(Boolean).map(String) : [];
  tx.update(orderRef, {
    stockDecrementedAt: claimedAt,
    stockDecrementedBy: by,
    stockDecrementedSkus: skuList,
  });
  return { claimed: true, at: claimedAt, by, skus: skuList };
}

/**
 * Komfort-Wrapper: kombiniert Read + Write in einem Aufruf.
 *
 * ⚠ ACHTUNG (Firestore-Read-before-Write):
 * Diese Funktion macht zuerst `tx.get(orderRef)`, dann ggf. `tx.update`.
 * Aufrufer, die in derselben Tx bereits andere Document-Writes ausgefuehrt
 * haben, MUESSEN stattdessen die phasen-getrennten Helper verwenden:
 *   1) `readOrderClaimStateInTx({tx, orderRef})` BEFORE the first write
 *   2) `writeOrderClaimInTx({tx, orderRef, by, skus, nowIso})` AFTER all reads
 *
 * Sonst wirft Firestore:
 *   "Firestore transactions require all reads to be executed before all writes."
 *
 * @param {object} args
 * @param {FirestoreTransaction} args.tx
 * @param {DocumentReference} args.orderRef
 * @param {'pick'|'ship'} args.by
 * @param {string[]} [args.skus]
 * @param {string} [args.nowIso]
 * @returns {Promise<{ claimed: boolean, alreadyClaimed: boolean, at: string|null, by: string|null, reason?: string }>}
 */
async function claimOrderStockDecrementInTx({ tx, orderRef, by, skus, nowIso } = {}) {
  _validateTx(tx);
  if (!orderRef) throw new Error('claimOrderStockDecrementInTx: orderRef missing');
  _validateBy(by);

  const state = await readOrderClaimStateInTx({ tx, orderRef });
  if (!state.exists) {
    return { claimed: false, alreadyClaimed: false, at: null, by: null, reason: 'order-not-found' };
  }
  if (state.alreadyClaimed) {
    return { claimed: false, alreadyClaimed: true, at: state.at, by: state.by };
  }
  const written = writeOrderClaimInTx({ tx, orderRef, by, skus, nowIso });
  return { claimed: true, alreadyClaimed: false, at: written.at, by: written.by };
}

/**
 * Phase 2 — reine Schreib-Phase (Append).
 * Haengt eine weitere SKU an einen BESTEHENDEN Pick-Claim an.
 *
 * Hintergrund: Bei Multi-SKU-Orders claimt der ERSTE Pick den Marker mit
 * seiner SKU. Jeder weitere Pick derselben Order sah frueher nur
 * `alreadyClaimed` und liess seine SKU fallen — der WP4-Re-Credit
 * (`_recreditOrderStock`) filtert aber strikt auf `stockDecrementedSkus`,
 * d.h. bei Cancel nach Voll-Pick kamen die uebrigen SKUs NIE zurueck ins
 * Lager (unsichtbarer Bestandsverlust). Deshalb MUSS jeder weitere Pick
 * seine SKU via arrayUnion anhaengen.
 *
 * Nur `tx.update` — sicher nach Reads. `existingSkus` MUSS aus dem
 * `readOrderClaimStateInTx`-Ergebnis DERSELBEN Tx stammen (Tx ist
 * serialisierbar, bei Konflikt retried Firestore die gesamte Tx —
 * kein Lost-Update).
 *
 * @param {object} args
 * @param {FirestoreTransaction} args.tx
 * @param {DocumentReference} args.orderRef
 * @param {string} args.sku
 * @param {string[]} [args.existingSkus] — Claim-SKUs aus der Read-Phase
 */
function appendOrderClaimSkuInTx({ tx, orderRef, sku, existingSkus } = {}) {
  _validateTx(tx);
  if (!orderRef) throw new Error('order-stock-claim: orderRef missing');
  const skuValue = (sku || '').toString().trim();
  if (!skuValue) return;
  const current = Array.isArray(existingSkus) ? existingSkus.filter(Boolean).map(String) : [];
  if (current.includes(skuValue)) return;
  tx.update(orderRef, {
    stockDecrementedSkus: [...current, skuValue],
  });
}

module.exports = {
  readOrderClaimStateInTx,
  writeOrderClaimInTx,
  appendOrderClaimSkuInTx,
  claimOrderStockDecrementInTx,
};
