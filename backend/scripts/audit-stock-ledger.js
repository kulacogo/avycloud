/**
 * audit-stock-ledger.js — WP3 / F1.X read-only Ist-Bestand-Audit.
 *
 * Vergleicht pro Produkt drei Quellen und MELDET Abweichungen — schreibt NIE:
 *   - projection = products_v2.inventory.quantity
 *   - ledger     = Σ warehouseEvents.delta (productId)
 *   - bins       = Σ warehouseBins[].products[].quantity (productId/sku)
 *
 * Pflicht-Vorstufe vor jeder Ledger-Eröffnung: der gefährliche Fall
 * „Projektion 0, aber Bestand liegt anderswo" (Zeroing-Verlust) wird als
 * `major` markiert, damit ein Mensch ihn bestätigt/korrigiert, BEVOR ein
 * Cutover ihn zementiert. Reine Audit-Logik in lib/stock-audit.js (getestet).
 *
 * Usage:
 *   node scripts/audit-stock-ledger.js [--tenantId default] [--limit 0]
 *                                      [--outDir /tmp] [--json] [--help]
 *
 * READ-ONLY: dieses Script enthält bewusst KEINE set/update/add/delete-Aufrufe.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { firestore } = require('../lib/firestore');
const { buildAuditRow, summarizeAudit } = require('../lib/stock-audit');

function parseArgs(argv) {
  const out = { tenantId: process.env.TENANT_ID || 'default', limit: 0, outDir: '/tmp', json: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--tenantId' && v) { out.tenantId = v; i++; }
    else if (a === '--limit' && v) { out.limit = Number(v) || 0; i++; }
    else if (a === '--outDir' && v) { out.outDir = v; i++; }
    else if (a === '--json') { out.json = true; }
    else if (a === '--help' || a === '-h') { out.help = true; }
  }
  return out;
}

async function loadProjections({ tenantId, limit }) {
  // products_v2.inventory.quantity = current projection.
  let q = firestore.collection('products_v2').where('tenantId', '==', tenantId);
  if (limit > 0) q = q.limit(limit);
  const snap = await q.get();
  const byId = new Map();
  snap.forEach((d) => {
    const data = d.data() || {};
    byId.set(d.id, {
      productId: d.id,
      sku: data.identification?.sku || data.details?.identifiers?.sku || null,
      projectionOnHand: Number(data.inventory?.quantity || 0),
    });
  });
  return byId;
}

async function loadLedgerByProduct() {
  // Σ warehouseEvents.delta per productId. Events are not tenant-filtered (legacy
  // docs lack tenantId); they are matched to the tenant's products by productId.
  const sums = new Map();
  const snap = await firestore.collection('warehouseEvents').select('productId', 'delta').get();
  snap.forEach((d) => {
    const e = d.data() || {};
    const pid = e.productId;
    if (!pid) return;
    const delta = Number(e.delta);
    sums.set(pid, (sums.get(pid) || 0) + (Number.isFinite(delta) ? delta : 0));
  });
  return sums;
}

async function loadBinQuantities() {
  // Σ warehouseBins[].products[].quantity, keyed by productId AND sku (fallback).
  const byProductId = new Map();
  const bySku = new Map();
  const snap = await firestore.collection('warehouseBins').get();
  snap.forEach((d) => {
    const products = Array.isArray(d.data()?.products) ? d.data().products : [];
    for (const p of products) {
      const qty = Number(p?.quantity || 0);
      if (!Number.isFinite(qty) || qty === 0) continue;
      const pid = String(p?.productId || '').trim();
      const sku = String(p?.sku || '').trim();
      if (pid) byProductId.set(pid, (byProductId.get(pid) || 0) + qty);
      if (sku) bySku.set(sku, (bySku.get(sku) || 0) + qty);
    }
  });
  return { byProductId, bySku };
}

function printReport(rows, summary, tenantId) {
  console.log('');
  console.log(`=== Stock-Ledger Audit (read-only) — tenant=${tenantId} ===`);
  console.log(`products audited : ${summary.total}`);
  console.log(`in sync (ok)     : ${summary.ok}`);
  console.log(`minor drift      : ${summary.minor}`);
  console.log(`MAJOR (review!)  : ${summary.major}`);
  console.log('flags:');
  for (const [flag, count] of Object.entries(summary.byFlag).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(5)}  ${flag}`);
  }
  const worst = rows
    .filter((r) => r.severity === 'major')
    .sort((a, b) => Math.abs(b.binVsLedger) - Math.abs(a.binVsLedger))
    .slice(0, 20);
  if (worst.length) {
    console.log('');
    console.log(`top ${worst.length} MAJOR offenders (projection / ledger / bins):`);
    for (const r of worst) {
      console.log(`  ${r.productId} sku=${r.sku || '-'}  proj=${r.projectionOnHand} ledger=${r.ledgerOnHand} bins=${r.binQuantity}  [${r.flags.join(', ')}]`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node scripts/audit-stock-ledger.js [--tenantId default] [--limit 0] [--outDir /tmp] [--json]');
    console.log('READ-ONLY. Compares projection vs Σ warehouseEvents vs warehouseBins per product.');
    return;
  }

  console.error(`[audit-stock-ledger] tenant=${args.tenantId} — loading (read-only)…`);
  const [projections, ledger, bins] = await Promise.all([
    loadProjections({ tenantId: args.tenantId, limit: args.limit }),
    loadLedgerByProduct(),
    loadBinQuantities(),
  ]);
  console.error(`[audit-stock-ledger] products=${projections.size} ledger-keys=${ledger.size} bin-pids=${bins.byProductId.size}`);

  const rows = [];
  for (const [productId, proj] of projections) {
    const binQuantity = bins.byProductId.get(productId)
      ?? (proj.sku ? bins.bySku.get(proj.sku) : undefined)
      ?? 0;
    rows.push(buildAuditRow({
      productId,
      sku: proj.sku,
      projectionOnHand: proj.projectionOnHand,
      events: [{ delta: ledger.get(productId) || 0 }], // ledger pre-summed per product → one delta carries Σ
      binQuantity,
    }));
  }

  const summary = summarizeAudit(rows);
  printReport(rows, summary, args.tenantId);

  // Write a durable report (read-only side effect: local file only).
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = path.join(args.outDir, `stock-ledger-audit-${args.tenantId}-${stamp}.json`);
    fs.writeFileSync(outFile, JSON.stringify({ tenantId: args.tenantId, summary, rows }, null, 2));
    console.error(`[audit-stock-ledger] report written: ${outFile}`);
  } catch (err) {
    console.error(`[audit-stock-ledger] report write failed (non-fatal): ${err.message}`);
  }

  if (args.json) console.log(JSON.stringify({ summary, rows }, null, 2));
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => {
    console.error('[audit-stock-ledger] FAILED:', err.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, loadBinQuantities };
