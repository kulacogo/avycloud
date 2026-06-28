/**
 * Order-Stock-Recredit-Claim — inverser Spiegel von `lib/order-stock-claim.js`.
 *
 * WP4 (symmetric stock re-credit). Siehe CLAUDE.md Punkt 13 (Stock Single
 * Writer Invariant) und docs/architecture/stock-single-source-of-truth.md.
 *
 * Wenn eine bereits dekrementierte Order storniert/retourniert wird (oder ihr
 * Versandlabel gecancelt wird), MUSS der Bestand GENAU EINMAL wieder
 * gutgeschrieben werden — symmetrisch zum Decrement. Ein wiederholter
 * cancel/return-Event (Marketplace-Re-Delivery, Retry, doppelter Webhook)
 * darf NIEMALS doppelt gutschreiben.
 *
 * Dafuer setzt dieser Helper denselben atomaren Marker-Mechanismus wie der
 * Decrement-Claim, nur auf den invertierten Feldern:
 *   { stockRecreditedAt: ISO,
 *     stockRecreditedBy: 'cancel' | 'return' | 'label-cancel',
 *     stockRecreditedSkus: [sku, ...] }
 *
 * Zwei Gates (das ist die Idempotency-Logik, auf der die WP4-Oversell-Safety
 * ruht):
 *   1) NEVER-DECREMENTED: wenn `stockDecrementedAt` unset ist, wurde nie
 *      dekrementiert → es gibt nichts gutzuschreiben → kein Claim.
 *   2) ALREADY-RECREDITED: wenn `stockRecreditedAt` bereits gesetzt ist,
 *      wurde schon gutgeschrieben → kein zweiter Claim (idempotent).
 * Nur wenn `decremented && !alreadyRecredited` wird der Marker geschrieben.
 *
 * Der Check-and-Set laeuft gegen den IN DERSELBEN Tx gelesenen Wert
 * (`tx.get` → conditional `tx.update`). Konkurrierende Invocations
 * serialisieren auf der Firestore-Tx → genau eine gewinnt.
 *
 * Wie der Decrement-Claim sind die Helper phasen-getrennt, damit Aufrufer,
 * die in derselben Tx bereits andere Reads/Writes ausfuehren, die Firestore-
 * Read-before-Write-Regel nicht verletzen:
 *
 *   • `readOrderRecreditStateInTx({tx, orderRef})`
 *       Reine LESE-Phase. MUSS vor dem ersten Write im Tx aufgerufen werden.
 *
 *   • `writeOrderRecreditClaimInTx({tx, orderRef, by, skus, nowIso})`
 *       Reine SCHREIB-Phase. MUSS nach allen Reads aufgerufen werden.
 *
 *   • `claimOrderStockRecreditInTx({tx, orderRef, by, skus, nowIso})`
 *       Komfort-Wrapper, der Read+Write in einem Aufruf kombiniert. Nur
 *       sicher, wenn der Tx-Aufrufer noch keine Writes gemacht hat.
 */

'use strict';

const ALLOWED_BY = ['cancel', 'return', 'label-cancel'];

function _validateTx(tx) {
  if (!tx || typeof tx.get !== 'function' || typeof tx.update !== 'function') {
    throw new Error('order-stock-recredit-claim: invalid tx');
  }
}

function _validateBy(by) {
  if (!ALLOWED_BY.includes(by)) {
    throw new Error(
      `order-stock-recredit-claim: invalid by="${by}" (must be 'cancel' | 'return' | 'label-cancel')`
    );
  }
}

/**
 * Phase 1 — reine Lese-Phase.
 * Liest den aktuellen Recredit-Zustand der Order. Macht KEINE Writes.
 * Sicher in jeder Tx, solange noch kein Write erfolgt ist.
 *
 * @param {object} args
 * @param {FirestoreTransaction} args.tx
 * @param {DocumentReference} args.orderRef
 * @returns {Promise<{
 *   exists: boolean,
 *   decremented: boolean,
 *   decrementedSkus: string[],
 *   alreadyRecredited: boolean,
 *   recreditedAt: string|null,
 *   recreditedBy: 'cancel'|'return'|'label-cancel'|null,
 *   recreditedSkus: string[]
 * }>}
 */
async function readOrderRecreditStateInTx({ tx, orderRef } = {}) {
  _validateTx(tx);
  if (!orderRef) throw new Error('order-stock-recredit-claim: orderRef missing');

  const snap = await tx.get(orderRef);
  if (!snap || !snap.exists) {
    return {
      exists: false,
      decremented: false,
      decrementedSkus: [],
      alreadyRecredited: false,
      recreditedAt: null,
      recreditedBy: null,
      recreditedSkus: [],
    };
  }
  const data = (snap.data && snap.data()) || {};
  const decrementedAt = data.stockDecrementedAt || null;
  const decrementedSkus = Array.isArray(data.stockDecrementedSkus)
    ? data.stockDecrementedSkus.map(String)
    : [];
  const recreditedAt = data.stockRecreditedAt || null;
  const recreditedBy = data.stockRecreditedBy || null;
  const recreditedSkus = Array.isArray(data.stockRecreditedSkus)
    ? data.stockRecreditedSkus.map(String)
    : [];
  return {
    exists: true,
    decremented: Boolean(decrementedAt),
    decrementedSkus,
    alreadyRecredited: Boolean(recreditedAt),
    recreditedAt,
    recreditedBy: ALLOWED_BY.includes(recreditedBy) ? recreditedBy : null,
    recreditedSkus,
  };
}

/**
 * Phase 2 — reine Schreib-Phase.
 * Setzt den Recredit-Marker. Macht NUR `tx.update`. Aufrufer muss vorher mit
 * `readOrderRecreditStateInTx` verifiziert haben, dass die Order existiert,
 * dekrementiert wurde und noch nicht re-credited ist.
 *
 * @param {object} args
 * @param {FirestoreTransaction} args.tx
 * @param {DocumentReference} args.orderRef
 * @param {'cancel'|'return'|'label-cancel'} args.by
 * @param {string[]} [args.skus]
 * @param {string} [args.nowIso]
 * @returns {{claimed: true, at: string, by: string, skus: string[]}}
 */
function writeOrderRecreditClaimInTx({ tx, orderRef, by, skus, nowIso } = {}) {
  _validateTx(tx);
  if (!orderRef) throw new Error('order-stock-recredit-claim: orderRef missing');
  _validateBy(by);

  const claimedAt = nowIso || new Date().toISOString();
  const skuList = Array.isArray(skus) ? skus.filter(Boolean).map(String) : [];
  tx.update(orderRef, {
    stockRecreditedAt: claimedAt,
    stockRecreditedBy: by,
    stockRecreditedSkus: skuList,
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
 *   1) `readOrderRecreditStateInTx({tx, orderRef})` BEFORE the first write
 *   2) `writeOrderRecreditClaimInTx({tx, orderRef, by, skus, nowIso})` AFTER all reads
 *
 * Sonst wirft Firestore:
 *   "Firestore transactions require all reads to be executed before all writes."
 *
 * Idempotency-Gates:
 *   - `{ claimed:false, reason:'order-not-found' }` wenn die Order fehlt.
 *   - `{ claimed:false, reason:'never-decremented' }` wenn `stockDecrementedAt`
 *     unset ist (nie dekrementiert → nichts gutzuschreiben).
 *   - `{ claimed:false, alreadyRecredited:true }` wenn `stockRecreditedAt`
 *     bereits gesetzt ist (idempotent — kein Doppel-Credit).
 *   - `{ claimed:true }` + tx.update NUR wenn `decremented && !alreadyRecredited`.
 *
 * @param {object} args
 * @param {FirestoreTransaction} args.tx
 * @param {DocumentReference} args.orderRef
 * @param {'cancel'|'return'|'label-cancel'} args.by
 * @param {string[]} [args.skus]
 * @param {string} [args.nowIso]
 * @returns {Promise<{ claimed: boolean, alreadyRecredited: boolean, at: string|null, by: string|null, reason?: string }>}
 */
async function claimOrderStockRecreditInTx({ tx, orderRef, by, skus, nowIso } = {}) {
  _validateTx(tx);
  if (!orderRef) throw new Error('claimOrderStockRecreditInTx: orderRef missing');
  _validateBy(by);

  const state = await readOrderRecreditStateInTx({ tx, orderRef });
  if (!state.exists) {
    return { claimed: false, alreadyRecredited: false, at: null, by: null, reason: 'order-not-found' };
  }
  if (state.alreadyRecredited) {
    return {
      claimed: false,
      alreadyRecredited: true,
      at: state.recreditedAt,
      by: state.recreditedBy,
    };
  }
  if (!state.decremented) {
    return { claimed: false, alreadyRecredited: false, at: null, by: null, reason: 'never-decremented' };
  }
  const written = writeOrderRecreditClaimInTx({ tx, orderRef, by, skus, nowIso });
  return { claimed: true, alreadyRecredited: false, at: written.at, by: written.by };
}

module.exports = {
  readOrderRecreditStateInTx,
  writeOrderRecreditClaimInTx,
  claimOrderStockRecreditInTx,
};
