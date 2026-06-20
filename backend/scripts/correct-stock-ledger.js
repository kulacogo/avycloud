/**
 * correct-stock-ledger.js — WP3 / F1.X ledger correction (DRY-RUN first).
 *
 * Bringt den Ledger (Σ warehouseEvents) pro driftendem Produkt auf die physische
 * Wahrheit (default `bins`) via idempotenter `adjust`-Buchung
 * (Key `adjust:opening:{productId}`). Fasst die Projektion NICHT an → erst der
 * STOCK_LEDGER-Cutover macht sie wirksam.
 *
 * SICHERHEIT:
 *   - DEFAULT = DRY-RUN: liest, plant, druckt, schreibt NICHTS.
 *   - `--apply` schreibt nur ZUSAMMEN mit `--confirm APPLY-F1X`.
 *   - Voraussetzung laut Runbook: frischer Export + PITR-Anker (WP3 Schritt 1).
 *
 * Usage:
 *   node scripts/correct-stock-ledger.js [--tenantId default] [--truthSource bins|projection]
 *                                        [--limit 0] [--outDir /tmp]
 *                                        [--apply --confirm APPLY-F1X]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { firestore } = require('../lib/firestore');
const { loadProjections, loadLedgerByProduct, loadBinQuantities } = require('./audit-stock-ledger');
const { buildAuditRow } = require('../lib/stock-audit');
const { planCorrections, applyLedgerCorrection } = require('../lib/stock-ledger-correction');

const CONFIRM_TOKEN = 'APPLY-F1X';

function parseArgs(argv) {
  const out = { tenantId: process.env.TENANT_ID || 'default', truthSource: 'bins', limit: 0, outDir: '/tmp', apply: false, confirm: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]; const v = argv[i + 1];
    if (a === '--tenantId' && v) { out.tenantId = v; i++; }
    else if (a === '--truthSource' && v) { out.truthSource = v; i++; }
    else if (a === '--limit' && v) { out.limit = Number(v) || 0; i++; }
    else if (a === '--outDir' && v) { out.outDir = v; i++; }
    else if (a === '--apply') { out.apply = true; }
    else if (a === '--confirm' && v) { out.confirm = v; i++; }
    else if (a === '--help' || a === '-h') { out.help = true; }
  }
  return out;
}

async function buildDriftRows({ tenantId, limit }) {
  const [projections, ledger, bins] = await Promise.all([
    loadProjections({ tenantId, limit }),
    loadLedgerByProduct(),
    loadBinQuantities(),
  ]);
  const rows = [];
  for (const [productId, proj] of projections) {
    const binQuantity = bins.byProductId.get(productId)
      ?? (proj.sku ? bins.bySku.get(proj.sku) : undefined)
      ?? 0;
    rows.push(buildAuditRow({
      productId,
      sku: proj.sku,
      projectionOnHand: proj.projectionOnHand,
      events: [{ delta: ledger.get(productId) || 0 }],
      binQuantity,
    }));
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: node scripts/correct-stock-ledger.js [--tenantId default] [--truthSource bins|projection] [--limit 0] [--apply --confirm APPLY-F1X]');
    console.log('DRY-RUN by default. --apply requires --confirm APPLY-F1X and a fresh export/PITR anchor.');
    return;
  }

  const mode = args.apply ? 'APPLY' : 'DRY-RUN';
  console.error(`[correct-stock-ledger] tenant=${args.tenantId} truthSource=${args.truthSource} mode=${mode} — loading…`);
  const rows = await buildDriftRows({ tenantId: args.tenantId, limit: args.limit });
  const plan = planCorrections(rows, { truthSource: args.truthSource });

  console.log('');
  console.log(`=== F1.X Ledger Correction — ${mode} (tenant=${args.tenantId}, truth=${args.truthSource}) ===`);
  console.log(`products scanned   : ${rows.length}`);
  console.log(`corrections planned: ${plan.summary.count}`);
  console.log(`  Σ positive adjust (recover stock into ledger): +${plan.summary.totalPositiveAdjust}`);
  console.log(`  Σ negative adjust (remove phantom from ledger): ${plan.summary.totalNegativeAdjust}`);
  const sample = plan.corrections.slice(0, 15);
  console.log(`sample (first ${sample.length}):`);
  for (const c of sample) {
    console.log(`  ${c.productId} sku=${c.sku || '-'}  ledger ${c.fromLedger} → ${c.target}  (adjust ${c.adjustDelta >= 0 ? '+' : ''}${c.adjustDelta})  key=${c.idempotencyKey}`);
  }

  // Always write the full plan for review.
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = path.join(args.outDir, `ledger-correction-plan-${args.tenantId}-${stamp}.json`);
    fs.writeFileSync(outFile, JSON.stringify({ tenantId: args.tenantId, truthSource: args.truthSource, mode, summary: plan.summary, corrections: plan.corrections }, null, 2));
    console.error(`[correct-stock-ledger] plan written: ${outFile}`);
  } catch (err) {
    console.error(`[correct-stock-ledger] plan write failed (non-fatal): ${err.message}`);
  }

  if (!args.apply) {
    console.log('');
    console.log('DRY-RUN only — nothing written. To apply: --apply --confirm ' + CONFIRM_TOKEN);
    return;
  }

  // ── APPLY (guarded) ──────────────────────────────────────────────────
  if (args.confirm !== CONFIRM_TOKEN) {
    console.error(`[correct-stock-ledger] REFUSED: --apply requires --confirm ${CONFIRM_TOKEN}`);
    process.exitCode = 2;
    return;
  }
  console.error(`[correct-stock-ledger] APPLYING ${plan.corrections.length} corrections…`);
  const result = { applied: 0, duplicate: 0, noop: 0, failed: 0 };
  for (const c of plan.corrections) {
    try {
      const r = await applyLedgerCorrection(
        { tenantId: args.tenantId, productId: c.productId, sku: c.sku, adjustDelta: c.adjustDelta, target: c.target, idempotencyKey: c.idempotencyKey },
        { firestore }
      );
      if (r.applied) result.applied++;
      else if (r.reason === 'duplicate') result.duplicate++;
      else result.noop++;
    } catch (err) {
      result.failed++;
      console.error(`[correct-stock-ledger] FAILED ${c.productId}: ${err.message}`);
    }
  }
  console.log(`=== APPLY done: applied=${result.applied} duplicate=${result.duplicate} noop=${result.noop} failed=${result.failed} ===`);
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0)).catch((err) => {
    console.error('[correct-stock-ledger] FATAL:', err.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, buildDriftRows };
