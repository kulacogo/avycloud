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
 * Diese Helper-Funktion ist der EINZIGE Ort, an dem `stockDecrementedAt`
 * im normalen Lifecycle gesetzt werden darf. (Ausnahme: Rollback-Path
 * via `FieldValue.delete()` in `order-state-machine.js`.)
 */

'use strict';

/**
 * Atomarer Claim innerhalb einer Firestore-Transaction.
 *
 * Aufgabe des Aufrufers:
 *   - `tx` darf noch keine Writes gemacht haben (oder die Reads in
 *     `tx.get(orderRef)` muessen vor dem ersten Write passieren —
 *     Firestore-Regel "alle Reads vor allen Writes").
 *   - Aufrufer entscheidet selbst, ob er den Claim als Erfolg
 *     interpretiert (claimed=true) oder ob er die fremde Claim
 *     respektiert (alreadyClaimed=true).
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
  if (!tx || typeof tx.get !== 'function' || typeof tx.update !== 'function') {
    throw new Error('claimOrderStockDecrementInTx: invalid tx');
  }
  if (!orderRef) throw new Error('claimOrderStockDecrementInTx: orderRef missing');
  const validBy = by === 'pick' || by === 'ship';
  if (!validBy) throw new Error(`claimOrderStockDecrementInTx: invalid by="${by}" (must be 'pick' | 'ship')`);

  const snap = await tx.get(orderRef);
  if (!snap || !snap.exists) {
    return { claimed: false, alreadyClaimed: false, at: null, by: null, reason: 'order-not-found' };
  }
  const data = (snap.data && snap.data()) || {};
  if (data.stockDecrementedAt) {
    return {
      claimed: false,
      alreadyClaimed: true,
      at: data.stockDecrementedAt,
      by: data.stockDecrementedBy || null,
    };
  }
  const claimedAt = nowIso || new Date().toISOString();
  const skuList = Array.isArray(skus) ? skus.filter(Boolean).map(String) : [];
  tx.update(orderRef, {
    stockDecrementedAt: claimedAt,
    stockDecrementedBy: by,
    stockDecrementedSkus: skuList,
  });
  return { claimed: true, alreadyClaimed: false, at: claimedAt, by };
}

module.exports = {
  claimOrderStockDecrementInTx,
};
