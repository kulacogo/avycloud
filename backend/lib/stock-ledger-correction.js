/**
 * stock-ledger-correction.js — WP3 / F1.X correction PLANNING (pure, read-only).
 *
 * Produziert `adjust`-Buchungsvorschläge, die den Ledger (Σ warehouseEvents) an
 * die physische Wahrheit angleichen, BEVOR der Ledger eröffnet wird. Schreibt
 * nichts — der Plan wird im Dry-Run geprüft, `--apply` führt ihn dann via
 * `stock-core.applyMovement` (deterministischer Key → idempotent) aus.
 *
 * Wahrheitsquelle (default `bins` = physisches Layout, wo die Ware liegt):
 *   target = truthSource-Wert · adjustDelta = target − ledgerOnHand
 * Deterministischer Idempotenz-Key `adjust:opening:{productId}` (Plan F1.X) →
 * ein versehentlicher Doppellauf bucht nie doppelt.
 */

'use strict';

const { buildMovementEventId } = require('./stock-core');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {Object} row - audit row ({productId, sku, ledgerOnHand, binQuantity, projectionOnHand})
 * @param {{truthSource?: 'bins'|'projection'}} [opts]
 * @returns {{needed:boolean, productId?:string, sku?:string, fromLedger?:number,
 *           target?:number, adjustDelta?:number, type?:string, idempotencyKey?:string}}
 */
function planLedgerCorrection(row, { truthSource = 'bins' } = {}) {
  const productId = row && row.productId;
  const ledgerOnHand = num(row && row.ledgerOnHand);
  const target = truthSource === 'projection' ? num(row && row.projectionOnHand) : num(row && row.binQuantity);
  const adjustDelta = target - ledgerOnHand;

  if (adjustDelta === 0) return { needed: false, productId };

  return {
    needed: true,
    productId,
    sku: (row && row.sku) || null,
    fromLedger: ledgerOnHand,
    target,
    adjustDelta,
    type: 'adjust',
    idempotencyKey: `adjust:opening:${productId}`,
  };
}

/**
 * Batch-Plan + Summary über mehrere Audit-Rows.
 * @param {Array} rows
 * @param {Object} [opts] - an planLedgerCorrection durchgereicht
 */
function planCorrections(rows, opts) {
  const list = Array.isArray(rows) ? rows : [];
  const corrections = [];
  let totalPositiveAdjust = 0;
  let totalNegativeAdjust = 0;
  for (const row of list) {
    const p = planLedgerCorrection(row, opts);
    if (!p.needed) continue;
    corrections.push(p);
    if (p.adjustDelta > 0) totalPositiveAdjust += p.adjustDelta;
    else totalNegativeAdjust += p.adjustDelta;
  }
  return {
    corrections,
    summary: { count: corrections.length, totalPositiveAdjust, totalNegativeAdjust },
  };
}

/**
 * applyLedgerCorrection — schreibt EINE idempotente `adjust`-Buchung, die den
 * Ledger (Σ warehouseEvents) zur physischen Wahrheit bringt. Fasst die Projektion
 * NICHT an (die wird erst beim STOCK_LEDGER-Cutover aus dem Ledger gespeist) →
 * verhaltensneutral bis zum Flip. Deterministischer Key → Doppellauf bucht nie doppelt.
 *
 * @param {Object} c - { tenantId, productId, adjustDelta, target, idempotencyKey, sku? }
 * @param {Object} deps - { firestore, now }
 * @returns {Promise<{applied:boolean, reason?:string, eventId?:string, delta?:number}>}
 */
async function applyLedgerCorrection({ tenantId = 'default', productId, adjustDelta, target, idempotencyKey, sku = null }, deps = {}) {
  const { firestore, now = Date.now() } = deps;
  if (!firestore) throw new Error('applyLedgerCorrection: firestore dependency required');
  if (!productId) throw new Error('applyLedgerCorrection: productId required');
  if (!idempotencyKey || typeof idempotencyKey !== 'string') throw new Error('applyLedgerCorrection: idempotencyKey required');
  const delta = Number(adjustDelta);
  if (!Number.isFinite(delta)) throw new Error('applyLedgerCorrection: numeric adjustDelta required');
  if (Number.isFinite(Number(target)) && Number(target) < 0) {
    throw new Error(`applyLedgerCorrection: refusing correction to negative target=${target} for ${productId}`);
  }
  if (delta === 0) return { applied: false, reason: 'noop', delta: 0 };

  const eventId = buildMovementEventId({ tenantId, idempotencyKey });
  return firestore.runTransaction(async (tx) => {
    const eventRef = firestore.collection('warehouseEvents').doc(eventId);
    const existing = await tx.get(eventRef);
    if (existing && existing.exists) return { applied: false, reason: 'duplicate', eventId };

    tx.set(eventRef, {
      type: 'adjust',
      tenantId,
      productId,
      sku: sku || null,
      delta,
      quantityAfter: Number.isFinite(Number(target)) ? Number(target) : null,
      idempotencyKey,
      meta: { kind: 'f1x-opening-correction' },
      createdAt: new Date(now).toISOString(),
    });
    return { applied: true, eventId, delta };
  });
}

module.exports = { planLedgerCorrection, planCorrections, applyLedgerCorrection };
