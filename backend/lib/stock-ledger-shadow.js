/**
 * stock-ledger-shadow.js — WP3 / F1 SHADOW (observe only, never mutate).
 *
 * Wenn `STOCK_LEDGER_SHADOW=true`: nach jeder echten Bestandsbewegung
 * (Hook in `notifyStockChange`) wird das neue Ledger PARALLEL nachgerechnet —
 * Σ `warehouseEvents.delta` vs. die fortgeschriebene Projektion (`after`) — und
 * NUR die Differenz geloggt (+ bei Drift ein Telemetrie-Doc in
 * `stock_ledger_shadow`). Es wird NICHTS am Bestand geändert; das Verhalten der
 * laufenden Produktion bleibt identisch. Das ist das „messbare Shadow"-Tor
 * (0 unerklärte Diffs über vollen Zyklus) vor dem `STOCK_LEDGER`-Cutover.
 *
 * Fail-safe: jeder Fehler wird geschluckt (Rückgabe null) — der Shadow darf die
 * auslösende Mutation NIE retrospektiv brechen.
 */

'use strict';

const { reconcileLedger } = require('./stock-core');

function ledgerShadowEnabled() {
  return String(process.env.STOCK_LEDGER_SHADOW || '').toLowerCase() === 'true';
}

/**
 * @param {Object} params
 * @param {string} params.productId
 * @param {number} params.projectionAfter - neue products_v2.inventory.quantity nach der Bewegung
 * @param {Object} [deps] - { firestore } injizierbar für Tests
 * @returns {Promise<null|{inSync:boolean, diff:number, ledgerOnHand:number, projectionOnHand:number}>}
 */
async function recordLedgerShadowDiff({ tenantId = 'default', productId, sku = null, projectionAfter, reason = 'unknown', source = 'unknown', now = Date.now() } = {}, deps = {}) {
  if (!productId) return null;
  const firestore = deps.firestore || require('./firestore').firestore;

  // Σ warehouseEvents.delta für das Produkt (productId ist global eindeutig).
  let ledgerOnHand = 0;
  try {
    const snap = await firestore.collection('warehouseEvents').where('productId', '==', productId).select('delta').get();
    snap.forEach((d) => {
      const x = Number(d.data() && d.data().delta);
      if (Number.isFinite(x)) ledgerOnHand += x;
    });
  } catch (err) {
    console.warn(`[ledger-shadow] events read failed productId=${productId}: ${err.message}`);
    return null; // fail-safe — never break the caller
  }

  const rec = reconcileLedger({ events: [{ delta: ledgerOnHand }], projectionOnHand: projectionAfter });

  if (!rec.inSync) {
    console.warn(`[ledger-shadow] DIFF productId=${productId} projection=${rec.projectionOnHand} ledger=${rec.ledgerOnHand} diff=${rec.diff} (reason=${reason})`);
    try {
      await firestore.collection('stock_ledger_shadow').add({
        tenantId,
        productId,
        sku: sku || null,
        projectionOnHand: rec.projectionOnHand,
        ledgerOnHand: rec.ledgerOnHand,
        diff: rec.diff,
        reason,
        source,
        createdAt: new Date(now).toISOString(),
      });
    } catch (err) {
      console.warn(`[ledger-shadow] telemetry write failed productId=${productId}: ${err.message}`);
    }
  }

  return rec;
}

module.exports = { recordLedgerShadowDiff, ledgerShadowEnabled };
