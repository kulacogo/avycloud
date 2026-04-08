#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * batch-optimize-all.js — "Alles optimieren" für alle Produkte mit BIN, nicht bei eBay.
 *
 * Nutzt die volle Gemini v2 Chat-Pipeline (Google Search Grounding) —
 * exakt derselbe Prompt wie der "Alles optimieren"-Button in der UI.
 * Vorschläge werden auto-akzeptiert und gespeichert.
 *
 * Usage:
 *   # Preview (nur zeigen welche Produkte betroffen wären):
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/batch-optimize-all.js --preview
 *
 *   # Dry-Run (Gemini läuft, aber NICHTS wird gespeichert):
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/batch-optimize-all.js --dry-run
 *
 *   # Dry-Run mit Limit (nur erste 3 Produkte):
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/batch-optimize-all.js --dry-run --limit 3
 *
 *   # LIVE (auto-accept + speichern):
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/batch-optimize-all.js --apply --expected-count 42
 *
 * Options:
 *   --preview             Nur eligible Produkte auflisten (kein Gemini-Call)
 *   --dry-run             Gemini aufrufen, aber NICHT speichern (Default)
 *   --apply               Änderungen wirklich speichern
 *   --expected-count <n>  Safety: Abbruch wenn eligible-Count nicht passt
 *   --limit <n>           Max Produkte verarbeiten
 *   --offset <n>          Erste N eligible überspringen
 *   --delay <ms>          Delay zwischen Produkten (Default: 3000ms)
 */

const { runBatchOptimize, previewBatchOptimize } = require('../services/batch-optimize');

function parseArgs(argv) {
  const args = {
    preview: false,
    apply: false,
    dryRun: true,
    expectedCount: 0,
    limit: 0,
    offset: 0,
    delay: 3000,
  };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--preview') args.preview = true;
    if (t === '--apply') { args.apply = true; args.dryRun = false; }
    if (t === '--dry-run') { args.dryRun = true; args.apply = false; }
    if (t === '--expected-count') { args.expectedCount = Number(argv[++i]); }
    if (t === '--limit') { args.limit = Number(argv[++i]); }
    if (t === '--offset') { args.offset = Number(argv[++i]); }
    if (t === '--delay') { args.delay = Number(argv[++i]); }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  BATCH OPTIMIZE — "Alles optimieren" (Gemini v2 + Auto-Accept)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Mode:     ${args.preview ? 'PREVIEW' : args.dryRun ? 'DRY-RUN' : '🔴 LIVE (apply=true)'}`);
  console.log(`  Limit:    ${args.limit || 'all'}`);
  console.log(`  Offset:   ${args.offset}`);
  console.log(`  Delay:    ${args.delay}ms`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // --- Preview mode ---
  if (args.preview) {
    const preview = await previewBatchOptimize();
    console.log(`Total products in DB: ${preview.totalProducts}`);
    console.log(`Eligible (BIN + not eBay): ${preview.eligibleCount}\n`);

    if (preview.products.length === 0) {
      console.log('Keine eligible Produkte gefunden.');
      process.exit(0);
    }

    console.log('Eligible Produkte:');
    console.log('─'.repeat(100));
    for (const p of preview.products) {
      const desc = p.hasDescription ? '✅' : '❌';
      const hl = p.hasHighlights ? '✅' : '❌';
      console.log(`  ${p.id}  |  ${(p.name || '').slice(0, 50).padEnd(50)}  |  BIN: ${(p.binCode || '').padEnd(14)}  |  Desc: ${desc}  Highlights: ${hl}`);
    }
    console.log('─'.repeat(100));
    console.log(`\nNächster Schritt: --dry-run oder --apply --expected-count ${preview.eligibleCount}`);
    process.exit(0);
  }

  // --- Safety check for --apply ---
  if (args.apply) {
    const preview = await previewBatchOptimize();
    const actualCount = Math.min(
      preview.eligibleCount - args.offset,
      args.limit > 0 ? args.limit : Infinity
    );

    if (args.expectedCount > 0 && preview.eligibleCount !== args.expectedCount) {
      console.error(`\n❌ SAFETY ABORT: expected ${args.expectedCount} eligible products, found ${preview.eligibleCount}`);
      console.error('   Use --preview to see current state, then adjust --expected-count.\n');
      process.exit(1);
    }

    console.log(`⚠️  LIVE MODE: Will optimize + save ${actualCount} products.`);
    console.log(`   Waiting 5 seconds... (Ctrl+C to abort)\n`);
    await new Promise(r => setTimeout(r, 5000));
  }

  // --- Set custom delay via env ---
  if (args.delay !== 3000) {
    process.env.BATCH_OPTIMIZE_DELAY_MS = String(args.delay);
  }

  // --- Run ---
  const result = await runBatchOptimize({
    dryRun: args.dryRun,
    limit: args.limit,
    offset: args.offset,
  });

  // --- Report ---
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  ERGEBNIS');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Eligible:  ${result.totalEligible}`);
  console.log(`  Processed: ${result.processed}`);
  console.log(`  Saved:     ${result.success}`);
  console.log(`  Errors:    ${result.errors}`);
  console.log(`  Skipped:   ${result.skipped} (Gemini hatte keine Änderungen)`);
  console.log(`  Duration:  ${result.elapsedFormatted}`);
  console.log(`  Mode:      ${result.dryRun ? 'DRY-RUN (nichts gespeichert)' : 'LIVE'}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // Per-product detail
  if (result.results.length > 0) {
    console.log('Details pro Produkt:');
    console.log('─'.repeat(100));
    for (const r of result.results) {
      const icon = r.status === 'saved' ? '✅' : r.status === 'dry_run' ? '🔵' : r.status === 'skipped' ? '⏭️' : '❌';
      const fields = r.changedFields ? r.changedFields.join(', ') : r.reason || r.error || '';
      console.log(`  ${icon} ${r.productId}  |  ${(r.productName || '').slice(0, 40).padEnd(40)}  |  ${r.status.padEnd(8)}  |  ${fields.slice(0, 60)}`);
    }
    console.log('─'.repeat(100));
  }

  // Exit
  if (result.errors > 0) {
    console.log(`\n⚠️  ${result.errors} Fehler aufgetreten. Siehe Logs oben.\n`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ FATAL ERROR:', err.message);
  console.error(err.stack);
  process.exit(2);
});
