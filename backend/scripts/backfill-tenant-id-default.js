'use strict';

/**
 * D.0b-Hotfix Phase B — Backfill tenantId='default' an alle Docs ohne tenantId-Feld
 * in products + products_v2 + users.
 *
 * Production-Realität (verifiziert 2026-05-11): Multi-Tenant wurde im Code
 * vorbereitet, aber Daten nie tagged. D.0b-Migration filterte
 * where('tenantId','==','default') → 0 Treffer. Hotfix-Phase-A liefert
 * Legacy-Compat (Full-Scan + In-Memory-Filter), aber Phase B bringt die Daten
 * in den korrekten Stand für Phase C (Legacy-Branch entfernen).
 *
 * Usage:
 *   node scripts/backfill-tenant-id-default.js --dry-run        # zeigt Plan
 *   node scripts/backfill-tenant-id-default.js --apply          # schreibt tatsächlich
 *   node scripts/backfill-tenant-id-default.js --apply --batch-size 200
 *   node scripts/backfill-tenant-id-default.js --apply --collection products_v2
 *
 * Idempotent: skip Docs die schon tenantId-Feld haben.
 * Defensive: Firestore-Batch (max 500 ops), 50ms Pace zwischen Batches.
 *
 * Plan-Phase: B (nach Hotfix Phase A deployed). Nach Phase B success →
 * Phase C: Legacy-Compat-Branch in lib/firestore.js + lib/product-store.js entfernen.
 */

const { firestore } = require('../lib/firestore');

const DEFAULT_TENANT_ID = 'default';
const COLLECTIONS = ['products', 'products_v2', 'users'];
const BATCH_SIZE_DEFAULT = 500;
const BATCH_PACE_MS = 50;

function parseArgs(argv) {
  const args = { dryRun: true, apply: false, batchSize: BATCH_SIZE_DEFAULT, collections: COLLECTIONS };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') { args.dryRun = false; args.apply = true; }
    else if (a === '--dry-run') { args.dryRun = true; args.apply = false; }
    else if (a === '--batch-size') { args.batchSize = parseInt(argv[++i], 10) || BATCH_SIZE_DEFAULT; }
    else if (a === '--collection') { args.collections = [argv[++i]]; }
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/backfill-tenant-id-default.js [--apply] [--batch-size N] [--collection NAME]');
      process.exit(0);
    }
  }
  return args;
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function backfillCollection(collectionName, opts) {
  const { dryRun, batchSize } = opts;
  console.log(`\n=== ${collectionName} ===`);
  const ref = firestore.collection(collectionName);
  const snapshot = await ref.get();
  console.log(`Total Docs: ${snapshot.size}`);

  let toBackfill = 0;
  let alreadyTagged = 0;
  let nonDefault = 0;
  const docsToBackfill = [];

  snapshot.forEach((doc) => {
    const data = doc.data();
    const tid = data?.tenantId;
    if (!tid) {
      toBackfill++;
      docsToBackfill.push(doc.ref);
    } else if (tid === DEFAULT_TENANT_ID) {
      alreadyTagged++;
    } else {
      nonDefault++;
    }
  });

  console.log(`  ohne tenantId → backfill: ${toBackfill}`);
  console.log(`  tenantId=default (skip):  ${alreadyTagged}`);
  console.log(`  tenantId!=default (skip): ${nonDefault}`);

  if (dryRun) {
    console.log(`  [DRY-RUN] würde ${toBackfill} Docs auf tenantId='${DEFAULT_TENANT_ID}' setzen.`);
    return { collection: collectionName, total: snapshot.size, backfilled: 0, dryRun: true, planned: toBackfill, skippedDefault: alreadyTagged, skippedNonDefault: nonDefault };
  }

  let written = 0;
  for (let i = 0; i < docsToBackfill.length; i += batchSize) {
    const batch = firestore.batch();
    const chunk = docsToBackfill.slice(i, i + batchSize);
    chunk.forEach((docRef) => batch.update(docRef, { tenantId: DEFAULT_TENANT_ID }));
    await batch.commit();
    written += chunk.length;
    console.log(`  Batch ${Math.floor(i / batchSize) + 1}: +${chunk.length} (total ${written}/${toBackfill})`);
    if (i + batchSize < docsToBackfill.length) await sleep(BATCH_PACE_MS);
  }

  console.log(`  ✓ Backfilled ${written} Docs.`);
  return { collection: collectionName, total: snapshot.size, backfilled: written, dryRun: false, skippedDefault: alreadyTagged, skippedNonDefault: nonDefault };
}

(async () => {
  const args = parseArgs(process.argv);
  console.log(`D.0b-Phase-B Backfill — ${args.dryRun ? 'DRY-RUN' : 'APPLY'}`);
  console.log(`Collections: ${args.collections.join(', ')}, batch-size=${args.batchSize}\n`);

  const results = [];
  for (const collection of args.collections) {
    try {
      const r = await backfillCollection(collection, args);
      results.push(r);
    } catch (err) {
      console.error(`  ERROR on ${collection}: ${err.message}`);
      results.push({ collection, error: err.message });
    }
  }

  console.log('\n=== Summary ===');
  for (const r of results) {
    if (r.error) console.log(`  ${r.collection}: ERROR ${r.error}`);
    else console.log(`  ${r.collection}: ${r.dryRun ? `planned ${r.planned}` : `wrote ${r.backfilled}`}, skipped-default=${r.skippedDefault}, skipped-other=${r.skippedNonDefault}`);
  }

  try {
    const fs = require('fs');
    fs.writeFileSync('/tmp/backfill-tenant-id-default-summary.json', JSON.stringify({ args, results, ts: new Date().toISOString() }, null, 2));
    console.log('Summary → /tmp/backfill-tenant-id-default-summary.json');
  } catch (_) {}

  process.exit(0);
})().catch((err) => { console.error('FATAL:', err); process.exit(1); });
