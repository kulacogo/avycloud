/**
 * stock-audit.js — WP3 / F1.X read-only Ist-Bestand-Audit (PRIO-1 vor Cutover).
 *
 * Vergleicht pro Produkt DREI Quellen, OHNE etwas zu schreiben:
 *   - projection  = `products_v2.inventory.quantity` (heutige Anzeige/Cache)
 *   - ledger      = Σ `warehouseEvents.delta` (die künftige Wahrheit)
 *   - bins        = Σ `warehouseBins[].products[].quantity` (physisches Layout)
 *
 * Zweck: bevor der Ledger eröffnet wird, müssen Abweichungen sichtbar gemacht
 * und von einem Menschen bestätigt/korrigiert werden — sonst zementiert eine
 * Eröffnungsbuchung den bekannten Zeroing-Verlust (Memory wms-bin-loss-rootcause).
 * Der gefährlichste Fall „Projektion 0, aber Bestand liegt anderswo" → `major`.
 *
 * Reine Funktionen — die Firestore-Reads macht das dünne Script
 * `scripts/audit-stock-ledger.js`. Hier wird NIE geschrieben.
 */

'use strict';

const { computeOnHandFromEvents } = require('./stock-core');

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {Object} input
 * @param {string} input.productId
 * @param {string} [input.sku]
 * @param {number} [input.projectionOnHand] - products_v2.inventory.quantity
 * @param {Array}  [input.events]           - warehouseEvents docs ({delta})
 * @param {number} [input.binQuantity]      - Σ warehouseBins quantity for product
 * @returns {Object} audit row (never throws)
 */
function buildAuditRow({ productId, sku = null, projectionOnHand, events = [], binQuantity } = {}) {
  const ledgerOnHand = computeOnHandFromEvents(events);
  const projection = num(projectionOnHand);
  const bins = num(binQuantity);

  const projVsLedger = projection - ledgerOnHand;
  const binVsLedger = bins - ledgerOnHand;
  const binVsProjection = bins - projection;

  const flags = [];
  // MAJOR = real physical stock (bins) that the projection misses → would be
  // LOST if the ledger is opened from the projection. The original zeroing fire.
  const binOrphanedStock = projection === 0 && bins > 0;
  // Ledger over-counts physical reality (stock_in booked, stock_out missing) →
  // opening onHand=Σ events would RESURRECT phantom stock → oversell. Not data
  // loss, but a hard cutover blocker; must be reconciled before STOCK_LEDGER.
  const ledgerOvercount = ledgerOnHand > bins && ledgerOnHand > projection;

  if (binOrphanedStock) flags.push('bin-orphaned-stock');
  if (ledgerOvercount) flags.push('ledger-overcount');
  if (ledgerOnHand === 0 && (bins > 0 || projection > 0)) flags.push('ledger-empty');
  if (binVsLedger !== 0) flags.push('bin-ledger-mismatch');
  if (projVsLedger !== 0) flags.push('projection-ledger-mismatch');

  const inSync = projVsLedger === 0 && binVsLedger === 0;
  let severity = 'ok';
  if (!inSync) severity = binOrphanedStock ? 'major' : 'minor';

  return {
    productId: productId || null,
    sku,
    ledgerOnHand,
    projectionOnHand: projection,
    binQuantity: bins,
    projVsLedger,
    binVsLedger,
    binVsProjection,
    inSync,
    severity,
    flags,
  };
}

/**
 * Aggregiert Audit-Rows zu einer Übersicht (Gate-Report).
 * @param {Array} rows
 */
function summarizeAudit(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const out = { total: list.length, ok: 0, minor: 0, major: 0, byFlag: {} };
  for (const r of list) {
    if (r.severity === 'ok') out.ok += 1;
    else if (r.severity === 'major') out.major += 1;
    else out.minor += 1;
    for (const f of r.flags || []) out.byFlag[f] = (out.byFlag[f] || 0) + 1;
  }
  return out;
}

module.exports = { buildAuditRow, summarizeAudit };
