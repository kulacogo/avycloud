'use strict';

/**
 * reset-books-gmbh.js — Zero the BOOKS for the TrendOcean Einzelunternehmen →
 * GmbH cutover. Wipes orders/invoices/returns/shipments/sync-logs + the
 * marketplace mirror collections, and resets number sequences to 0.
 *
 * MUST run only AFTER `export-legacy-invoices.js --apply` reported ok
 * (GoBD/§147 archive) and while the worker + invoice crons are quiesced.
 *
 * GOLDENE REGEL: production stock is NEVER touched. This script wipes by a
 * WHITELIST and, before deleting anything, pre-flights EVERY target through
 * `assertSafeToWipe` — a protected collection anywhere in the list aborts the
 * whole run before a single delete. Stock/product/warehouse/company collections
 * are on the protected list and can never be wiped here.
 *
 * Clearing the product listing pointers (ops.ebay.itemId etc.) is a SEPARATE,
 * safety-reviewed step (must round-trip the full product through saveProductV2
 * with skipStockEvent) — intentionally NOT part of this wipe.
 *
 * DRY-RUN by default. Writes only with --apply.
 */

// Collections wiped for the cutover. tenantScoped ⇒ filtered by tenantId;
// the marketplace mirrors carry no tenantId and are wiped whole.
const WIPE_COLLECTIONS = [
  { name: 'orders', tenantScoped: true },
  { name: 'order_events', tenantScoped: true },
  { name: 'returns', tenantScoped: true },
  // return_events writer (returns-engine.js) omits tenantId → must wipe whole,
  // else a tenantId filter deletes nothing (books stay non-empty).
  { name: 'return_events', tenantScoped: false },
  { name: 'invoices', tenantScoped: true },
  { name: 'shipments', tenantScoped: true },
  { name: 'stock_sync_log', tenantScoped: true },
  { name: 'stock_operation_failures', tenantScoped: true },
  // dual-write sibling of stock_operation_failures (stock-sync-dispatcher.js) — carries tenantId.
  { name: 'stock_sync_failures', tenantScoped: true },
  { name: 'stock_failure_alerts', tenantScoped: true },
  { name: 'refund_corrections', tenantScoped: true },
  { name: 'stock_reservations', tenantScoped: true },
  { name: 'marketplace_drift', tenantScoped: true },
  // stock-reconciliation.js spreads ...result without tenantId → wipe whole.
  { name: 'stock_reconciliation_log', tenantScoped: false },
  // marketplace mirrors — account-bound, no tenantId, wipe whole
  { name: 'ebayListingsLive', tenantScoped: false },
  { name: 'ebayListingLinks', tenantScoped: false },
  { name: 'kauflandUnitsLive', tenantScoped: false },
  { name: 'kaufland_publish_runs', tenantScoped: false },
];

// Collections that must NEVER be deleted by this script. Stock is derived from
// warehouseBins/warehouseEvents (STOCK_LEDGER) — deleting them zeroes all stock.
// number_sequences is RESET in place, never deleted. company_settings holds the
// firm identity. `trendocean` is a product-image collection (brand-named).
const PROTECTED_COLLECTIONS = [
  'products_v2',
  'products',
  'warehouseBins',
  'warehouseEvents',
  'storageBins',
  'warehouseZones',
  'inventory_ledger',
  'company_settings',
  'number_sequences',
  'stock_locks',
  'trendocean',
];

const SEQUENCE_COLLECTION = 'number_sequences';
const SEQUENCE_TYPES = ['order', 'invoice', 'delivery_note', 'return', 'shipment'];

/**
 * The single safety gate. Throws if asked to wipe a protected collection.
 * Returns true for a safe (whitelisted) collection.
 */
function assertSafeToWipe(name) {
  if (PROTECTED_COLLECTIONS.includes(name)) {
    throw new Error(
      `REFUSED: '${name}' is a PROTECTED collection and must never be wiped (GOLDENE REGEL: stock/products/company).`
    );
  }
  return true;
}

/** The Firestore doc body that resets a number sequence to a fresh year. */
function numberSequenceResetDoc({ tenantId, type, year }) {
  return { tenantId, type, year, currentNumber: 0 };
}

/**
 * GoBD/§147 gate: the books may only be wiped AFTER the legacy invoices are
 * archived and verified. Throws unless a verified export manifest (ok:true) is
 * present. Fail-closed — a missing/failed archive blocks the wipe.
 */
function assertArchivePresent(manifest) {
  if (!manifest || manifest.ok !== true) {
    throw new Error(
      'REFUSED: kein verifiziertes Archiv-Manifest (export-legacy-invoices.js --apply muss mit ok:true gelaufen sein). GoBD/§147: erst archivieren, dann löschen.'
    );
  }
  return true;
}

/**
 * Orchestrate the reset. All I/O injected (firestore) for testability.
 * deps: { firestore, tenantId='default', apply=false, currentYear,
 *         wipeCollections=WIPE_COLLECTIONS, sequenceTypes=SEQUENCE_TYPES, log }
 */
async function runReset(deps) {
  const {
    firestore,
    tenantId = 'default',
    apply = false,
    currentYear,
    wipeCollections = WIPE_COLLECTIONS,
    sequenceTypes = SEQUENCE_TYPES,
    log = () => {},
  } = deps;

  // ── PRE-FLIGHT: verify EVERY target is safe BEFORE deleting anything. ──
  // A protected collection anywhere in the list aborts the whole run.
  for (const c of wipeCollections) assertSafeToWipe(c.name);

  const wiped = [];
  for (const c of wipeCollections) {
    const col = firestore.collection(c.name);
    const query = c.tenantScoped ? col.where('tenantId', '==', tenantId) : col;
    const snap = await query.get();
    const count = snap.size != null ? snap.size : (snap.docs || []).length;

    let deleted = 0;
    if (apply) {
      for (const d of snap.docs || []) {
        await d.ref.delete();
        deleted += 1;
      }
    }
    wiped.push({ name: c.name, count, deleted });
    log(`  ${apply ? 'wiped' : 'would wipe'} ${c.name}: ${count}`);
  }

  const sequencesReset = [];
  for (const type of sequenceTypes) {
    const docId = `${tenantId}__${type}`;
    const payload = numberSequenceResetDoc({ tenantId, type, year: currentYear });
    if (apply) {
      await firestore.collection(SEQUENCE_COLLECTION).doc(docId).set(payload, { merge: true });
    }
    sequencesReset.push({ docId, ...payload });
    log(`  ${apply ? 'reset' : 'would reset'} sequence ${docId} → 0`);
  }

  return { apply, tenantId, wiped, sequencesReset };
}

/** Parse CLI args. DRY-RUN is the default; --apply is required to write. */
function parseArgs(argv) {
  const val = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  return {
    apply: argv.includes('--apply'),
    tenant: val('--tenant') || 'default',
    archiveDir: val('--archive'),
    confirmed: argv.includes('--i-have-archived'),
  };
}

module.exports = {
  assertSafeToWipe,
  assertArchivePresent,
  numberSequenceResetDoc,
  runReset,
  parseArgs,
  WIPE_COLLECTIONS,
  PROTECTED_COLLECTIONS,
  SEQUENCE_TYPES,
};

// ─── CLI entry (thin glue over the tested core) ────────────────────────────
if (require.main === module) {
  (async () => {
    const args = parseArgs(process.argv.slice(2));
    const { firestore } = require('../lib/firestore');
    const currentYear = new Date().getFullYear();

    console.log('════════════════════════════════════════════════════════════');
    console.log(' reset-books-gmbh — Bücher auf NULL (Einzelunternehmen → GmbH)');
    console.log('════════════════════════════════════════════════════════════');
    console.log(`  tenant=${args.tenant}  mode=${args.apply ? 'APPLY (löscht!)' : 'DRY-RUN'}`);
    if (args.apply) {
      console.log('  ⚠️  VORAUSSETZUNG: export-legacy-invoices.js --apply muss mit "ok" gelaufen sein,');
      console.log('      Worker + Rechnungs-Crons müssen gestoppt sein. Bestand/Lager wird NICHT angefasst.');

      // ── GoBD/§147 gate: verified archive + explicit confirmation required. ──
      const fs = require('fs');
      const path = require('path');
      const archiveDir = args.archiveDir || path.join(process.cwd(), 'legacy-invoice-archive', args.tenant);
      const manifestPath = path.join(archiveDir, '_manifest.json');
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) { /* handled below */ }
      try {
        assertArchivePresent(manifest);
      } catch (e) {
        console.error(`\n❌ ${e.message}\n   Erwartet: ${manifestPath} (ok:true). Erst den Export laufen lassen.`);
        process.exit(1);
      }
      if (!args.confirmed) {
        console.error('\n❌ REFUSED: --apply erfordert zusätzlich --i-have-archived (Bestätigung, dass das Archiv geprüft wurde).');
        process.exit(1);
      }
      console.log(`  ✓ Archiv verifiziert: ${manifestPath} (ok, ${manifest.count} Rechnungen).`);
    }

    const result = await runReset({
      firestore,
      tenantId: args.tenant,
      apply: args.apply,
      currentYear,
      log: (m) => process.stdout.write(`${m}\n`),
    });

    const totalDocs = result.wiped.reduce((s, w) => s + w.count, 0);
    console.log(`\n  Collections: ${result.wiped.length}, Dokumente ${args.apply ? 'gelöscht' : 'betroffen'}: ${totalDocs}`);
    console.log(`  Nummernkreise zurückgesetzt: ${result.sequencesReset.length}`);
    if (!args.apply) {
      console.log('\nDRY-RUN — nichts verändert. Mit --apply ausführen (NUR nach ok-Export + Quiesce).');
    } else {
      console.log('\n✅ Reset ausgeführt. Bestand/Lager/Produkte unangetastet.');
    }
    process.exit(0);
  })().catch((err) => {
    console.error(`[reset-books-gmbh] FATAL: ${err.message}`, err);
    process.exit(1);
  });
}
