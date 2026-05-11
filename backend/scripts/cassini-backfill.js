#!/usr/bin/env node
'use strict';

/**
 * D.5 Cassini-Backfill-Job — schreibt ops.data_quality.{identify_v4|v3}.cassini für historische Produkte.
 * Plan: /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.5)
 * Usage: node scripts/cassini-backfill.js --tenant avycloud --apply --days 90
 * Resume: node scripts/cassini-backfill.js --tenant avycloud --apply --resume
 *
 * Funktionalität:
 *   - Lädt Produkte aus `products_v2` gefiltert auf tenantId + identifyCheckedAtIso >= cutoff.
 *   - Pro Doc: prüft ob `ops.data_quality.identify_v4.cassini` ODER
 *     `ops.data_quality.identify_v3.cassini` bereits existiert → skip (idempotent).
 *   - Andernfalls: ruft scoreProductCassini(product) auf und schreibt das Ergebnis
 *     in die passende Pipeline-Sub-Map (identify_v4.cassini bevorzugt, sonst identify_v3.cassini).
 *   - Batch-Writes über BulkWriter (default 500 ops/batch, 50ms Pause zwischen Commits).
 *   - Cursor-Persistierung in `system/cassini-backfill-state/{tenantId}` —
 *     ermöglicht --resume nach Crash.
 *   - Graceful-Stub-Mode: ohne Firestore-Connection wird ein Dry-Run-Bericht ohne
 *     Writes erzeugt (Exit 0).
 *
 * Output: /tmp/cassini-backfill-summary.json
 *   { processed, skipped, errors, started_at, completed_at, last_doc_id, tenantId, dryRun }
 *
 * Constraints:
 *   - tenantId ist mandatory.
 *   - --dry-run (default) führt KEINE Schreiboperationen aus.
 *   - Cursor-Doc-Updates sind additiv (merge:true).
 *   - 2-Space, Single Quotes, CommonJS.
 */

const fs = require('fs');
const path = require('path');

const SUMMARY_PATH = '/tmp/cassini-backfill-summary.json';
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_DAYS = 90;
const BATCH_SLEEP_MS = 50;

// -------------------------------------------------------------------------
// Args
// -------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    tenantId: null,
    dryRun: true,
    apply: false,
    batchSize: DEFAULT_BATCH_SIZE,
    days: DEFAULT_DAYS,
    resume: false,
    help: false,
  };
  const list = argv.slice(2);
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--tenant' && list[i + 1]) {
      args.tenantId = String(list[++i]).trim();
    } else if (a.startsWith('--tenant=')) {
      args.tenantId = String(a.slice('--tenant='.length)).trim();
    } else if (a === '--apply') {
      args.apply = true;
      args.dryRun = false;
    } else if (a === '--dry-run') {
      args.dryRun = true;
      args.apply = false;
    } else if (a === '--batch-size' && list[i + 1]) {
      const n = Number(list[++i]);
      if (Number.isFinite(n) && n > 0) args.batchSize = Math.floor(n);
    } else if (a.startsWith('--batch-size=')) {
      const n = Number(a.slice('--batch-size='.length));
      if (Number.isFinite(n) && n > 0) args.batchSize = Math.floor(n);
    } else if (a === '--days' && list[i + 1]) {
      const n = Number(list[++i]);
      if (Number.isFinite(n) && n > 0) args.days = Math.floor(n);
    } else if (a.startsWith('--days=')) {
      const n = Number(a.slice('--days='.length));
      if (Number.isFinite(n) && n > 0) args.days = Math.floor(n);
    } else if (a === '--resume') {
      args.resume = true;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  // eslint-disable-next-line no-console
  console.log(`Usage: node scripts/cassini-backfill.js --tenant <tenantId> [options]

Required:
  --tenant <id>        Tenant identifier (mandatory).

Options:
  --dry-run            Default. No writes. Reports what would happen.
  --apply              Persist Cassini scores to Firestore.
  --batch-size <n>     Writes per batch commit (default ${DEFAULT_BATCH_SIZE}).
  --days <n>           Look-back window in days for identifyCheckedAtIso (default ${DEFAULT_DAYS}).
  --resume             Continue from previously saved cursor (system/cassini-backfill-state/{tenantId}).
  --help, -h           Show this message.

Output: ${SUMMARY_PATH}
`);
}

// -------------------------------------------------------------------------
// Date / cutoff
// -------------------------------------------------------------------------

function isoFromDaysAgo(days) {
  const ms = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

// -------------------------------------------------------------------------
// Pipeline detection
// -------------------------------------------------------------------------

/**
 * Decides which sub-map to write the cassini result under.
 * Rule: prefer identify_v4 if v4 metadata exists, else identify_v3,
 * else default to identify_v4 (forward-compatible).
 *
 * Returns one of: 'identify_v4' | 'identify_v3'.
 */
function pickPipelineKey(product) {
  const dq = product && product.ops && product.ops.data_quality;
  if (!dq || typeof dq !== 'object') return 'identify_v4';
  if (dq.identify_v4 && typeof dq.identify_v4 === 'object') return 'identify_v4';
  if (dq.identify_v3 && typeof dq.identify_v3 === 'object') return 'identify_v3';
  return 'identify_v4';
}

/**
 * Idempotency check: returns true if the product already has a cassini
 * sub-block under identify_v3 OR identify_v4.
 */
function alreadyHasCassini(product) {
  const dq = product && product.ops && product.ops.data_quality;
  if (!dq || typeof dq !== 'object') return false;
  const v4Cassini =
    dq.identify_v4 && typeof dq.identify_v4 === 'object' && dq.identify_v4.cassini;
  const v3Cassini =
    dq.identify_v3 && typeof dq.identify_v3 === 'object' && dq.identify_v3.cassini;
  return Boolean(v4Cassini || v3Cassini);
}

// -------------------------------------------------------------------------
// Firestore loaders (defensive — graceful stub-mode)
// -------------------------------------------------------------------------

function tryLoadFirestore() {
  try {
    const { firestore } = require('../lib/firestore');
    if (!firestore || typeof firestore.collection !== 'function') {
      return { firestore: null, error: 'firestore export missing or invalid' };
    }
    return { firestore, error: null };
  } catch (err) {
    return { firestore: null, error: err && err.message ? err.message : String(err) };
  }
}

function tryLoadScorer() {
  try {
    const mod = require('../lib/cassini-scorer');
    if (!mod || typeof mod.scoreProductCassini !== 'function') {
      return { scoreProductCassini: null, error: 'cassini-scorer export invalid' };
    }
    return { scoreProductCassini: mod.scoreProductCassini, error: null };
  } catch (err) {
    return { scoreProductCassini: null, error: err && err.message ? err.message : String(err) };
  }
}

// -------------------------------------------------------------------------
// Cursor (system/cassini-backfill-state/{tenantId})
// -------------------------------------------------------------------------

const STATE_COLLECTION = 'system';
const STATE_SUBCOLLECTION = 'cassini-backfill-state';

async function readCursor(firestore, tenantId) {
  try {
    const ref = firestore
      .collection(STATE_COLLECTION)
      .doc(STATE_SUBCOLLECTION)
      .collection('tenants')
      .doc(tenantId);
    const snap = await ref.get();
    if (!snap || !snap.exists) return null;
    const data = typeof snap.data === 'function' ? snap.data() : null;
    return data && typeof data === 'object' ? data : null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[cassini-backfill] readCursor failed: ${err.message}`);
    return null;
  }
}

async function writeCursor(firestore, tenantId, payload) {
  try {
    const ref = firestore
      .collection(STATE_COLLECTION)
      .doc(STATE_SUBCOLLECTION)
      .collection('tenants')
      .doc(tenantId);
    await ref.set({ ...payload, tenantId, updatedAtIso: new Date().toISOString() }, { merge: true });
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[cassini-backfill] writeCursor failed: ${err.message}`);
    return false;
  }
}

// -------------------------------------------------------------------------
// Page-iterator over products_v2 with cursor + look-back-window.
// -------------------------------------------------------------------------

const PRODUCTS_COLLECTION = 'products_v2';

/**
 * Build the base query: tenantId == X, identifyCheckedAtIso >= cutoff,
 * orderBy identifyCheckedAtIso asc, limit pageSize.
 *
 * If lastDocSnapshot is provided, applies startAfter() — caller passes a
 * QueryDocumentSnapshot or a doc-ref obtained via .doc(id).get().
 */
function buildBaseQuery(firestore, { tenantId, cutoffIso, pageSize }) {
  return firestore
    .collection(PRODUCTS_COLLECTION)
    .where('tenantId', '==', tenantId)
    .where('identifyCheckedAtIso', '>=', cutoffIso)
    .orderBy('identifyCheckedAtIso', 'asc')
    .limit(pageSize);
}

// -------------------------------------------------------------------------
// Sleep helper (test-overridable).
// -------------------------------------------------------------------------

function sleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -------------------------------------------------------------------------
// Build update for a single product.
// -------------------------------------------------------------------------

function buildUpdateForProduct(product, scoreFn) {
  const pipelineKey = pickPipelineKey(product);
  const score = scoreFn(product) || {};
  const cassiniPayload = {
    overall: typeof score.overall === 'number' ? score.overall : 0,
    title_score: typeof score.title_score === 'number' ? score.title_score : 0,
    description_score: typeof score.description_score === 'number' ? score.description_score : 0,
    image_score: typeof score.image_score === 'number' ? score.image_score : 0,
    specifics_score: typeof score.specifics_score === 'number' ? score.specifics_score : 0,
    compliance_score: typeof score.compliance_score === 'number' ? score.compliance_score : 0,
    issues: Array.isArray(score.issues) ? score.issues : [],
    scored_at_iso: new Date().toISOString(),
    backfill_version: 'd5-v1',
  };
  const updatePath = `ops.data_quality.${pipelineKey}.cassini`;
  return { pipelineKey, updatePath, cassiniPayload };
}

// -------------------------------------------------------------------------
// Main backfill flow.
// -------------------------------------------------------------------------

/**
 * runBackfill — exported for tests; main() wires CLI args.
 *
 * @param {object} deps
 *   - firestore: Firestore client (or null for stub-mode).
 *   - scoreProductCassini: function (or null for stub-mode).
 *   - args: parsed CLI args.
 *   - now: optional clock injection for deterministic cutoff.
 *   - sleepFn: optional sleep override (tests pass () => Promise.resolve()).
 *
 * @returns {Promise<object>} summary
 */
async function runBackfill(deps) {
  const {
    firestore,
    scoreProductCassini,
    args,
    now = () => Date.now(),
    sleepFn = sleep,
  } = deps || {};

  const startedAt = new Date(typeof now === 'function' ? now() : Date.now()).toISOString();
  const cutoffIso = new Date((typeof now === 'function' ? now() : Date.now()) - args.days * 24 * 60 * 60 * 1000).toISOString();

  const summary = {
    tenantId: args.tenantId,
    dryRun: Boolean(args.dryRun),
    days: args.days,
    batchSize: args.batchSize,
    cutoff_iso: cutoffIso,
    started_at: startedAt,
    completed_at: null,
    processed: 0,
    skipped: 0,
    errors: 0,
    pages: 0,
    last_doc_id: null,
    pipelineCounts: { identify_v4: 0, identify_v3: 0 },
    stub_mode: false,
    error_details: [],
  };

  if (!firestore || typeof scoreProductCassini !== 'function') {
    summary.stub_mode = true;
    summary.completed_at = new Date(typeof now === 'function' ? now() : Date.now()).toISOString();
    // eslint-disable-next-line no-console
    console.warn('[cassini-backfill] STUB MODE — Firestore/scorer unavailable. No work performed.');
    return summary;
  }

  // ---- Cursor resume ----------------------------------------------------
  let cursorState = null;
  let startAfterDocId = null;
  let startAfterDocSnap = null;
  if (args.resume) {
    cursorState = await readCursor(firestore, args.tenantId);
    if (cursorState && cursorState.lastDocId) {
      startAfterDocId = String(cursorState.lastDocId);
      // eslint-disable-next-line no-console
      console.log(`[cassini-backfill] Resuming from lastDocId=${startAfterDocId}`);
      try {
        startAfterDocSnap = await firestore.collection(PRODUCTS_COLLECTION).doc(startAfterDocId).get();
        if (!startAfterDocSnap || !startAfterDocSnap.exists) {
          // eslint-disable-next-line no-console
          console.warn(`[cassini-backfill] startAfterDoc ${startAfterDocId} not found; restarting from beginning.`);
          startAfterDocSnap = null;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[cassini-backfill] startAfter-doc lookup failed: ${err.message}`);
        startAfterDocSnap = null;
      }
    }
    if (cursorState && Number.isFinite(cursorState.processedCount)) {
      // Carry over previous counters when resuming.
      summary.processed += Number(cursorState.processedCount) || 0;
    }
  }

  // ---- BulkWriter (optional — defensive) -------------------------------
  let bulkWriter = null;
  if (!args.dryRun && typeof firestore.bulkWriter === 'function') {
    try {
      bulkWriter = firestore.bulkWriter({
        throttling: { initialOpsPerSecond: 50, maxOpsPerSecond: 250 },
      });
      bulkWriter.onWriteError((error) => {
        // eslint-disable-next-line no-console
        console.error('[cassini-backfill] write error', error.documentRef && error.documentRef.path, error.message);
        if (error.code === 'unavailable' && error.failedAttempts < 6) return true;
        return false;
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[cassini-backfill] bulkWriter unavailable: ${err.message} — falling back to batch().`);
      bulkWriter = null;
    }
  }

  // ---- Paginate ---------------------------------------------------------
  let pageGuard = 0;
  const PAGE_GUARD_MAX = 10000; // safety against infinite loops in tests with broken stubs
  let hasMore = true;

  while (hasMore && pageGuard < PAGE_GUARD_MAX) {
    pageGuard += 1;
    let query = buildBaseQuery(firestore, {
      tenantId: args.tenantId,
      cutoffIso,
      pageSize: args.batchSize,
    });
    if (startAfterDocSnap) {
      try {
        query = query.startAfter(startAfterDocSnap);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[cassini-backfill] startAfter failed: ${err.message}`);
        break;
      }
    }

    let snap;
    try {
      snap = await query.get();
    } catch (err) {
      summary.errors += 1;
      summary.error_details.push({ stage: 'query', message: err.message });
      // eslint-disable-next-line no-console
      console.error(`[cassini-backfill] query failed: ${err.message}`);
      break;
    }

    const docs = snap && Array.isArray(snap.docs) ? snap.docs : [];
    if (!docs.length) {
      hasMore = false;
      break;
    }

    summary.pages += 1;

    let writesInBatch = 0;
    let firestoreBatch = null;
    if (!args.dryRun && !bulkWriter && typeof firestore.batch === 'function') {
      firestoreBatch = firestore.batch();
    }

    for (const doc of docs) {
      const id = doc.id;
      const data = typeof doc.data === 'function' ? doc.data() : doc.data || {};
      if (!data || typeof data !== 'object') {
        summary.skipped += 1;
        continue;
      }
      summary.last_doc_id = id;

      if (alreadyHasCassini(data)) {
        summary.skipped += 1;
        continue;
      }

      let update;
      try {
        update = buildUpdateForProduct(data, scoreProductCassini);
      } catch (err) {
        summary.errors += 1;
        summary.error_details.push({ stage: 'score', docId: id, message: err.message });
        // eslint-disable-next-line no-console
        console.error(`[cassini-backfill] score failed for ${id}: ${err.message}`);
        continue;
      }

      summary.pipelineCounts[update.pipelineKey] =
        (summary.pipelineCounts[update.pipelineKey] || 0) + 1;

      if (args.dryRun) {
        summary.processed += 1;
        continue;
      }

      const docRef = firestore.collection(PRODUCTS_COLLECTION).doc(id);
      const updatePayload = { [update.updatePath]: update.cassiniPayload };
      try {
        if (bulkWriter) {
          bulkWriter.update(docRef, updatePayload);
        } else if (firestoreBatch) {
          firestoreBatch.update(docRef, updatePayload);
        } else if (typeof docRef.update === 'function') {
          // last-resort path: per-doc update
          await docRef.update(updatePayload);
        }
        writesInBatch += 1;
        summary.processed += 1;
      } catch (err) {
        summary.errors += 1;
        summary.error_details.push({ stage: 'write', docId: id, message: err.message });
        // eslint-disable-next-line no-console
        console.error(`[cassini-backfill] write failed for ${id}: ${err.message}`);
      }
    }

    // Commit batch (if we built one).
    if (!args.dryRun && firestoreBatch && writesInBatch > 0) {
      try {
        await firestoreBatch.commit();
      } catch (err) {
        summary.errors += 1;
        summary.error_details.push({ stage: 'commit', message: err.message });
        // eslint-disable-next-line no-console
        console.error(`[cassini-backfill] batch commit failed: ${err.message}`);
      }
    }

    // Cursor-doc update (non-destructive merge) after every batch.
    if (!args.dryRun) {
      await writeCursor(firestore, args.tenantId, {
        lastDocId: summary.last_doc_id,
        processedCount: summary.processed,
        pages: summary.pages,
      });
    }

    // Decide whether to continue: last-doc seen, fewer than batchSize ⇒ done.
    if (docs.length < args.batchSize) {
      hasMore = false;
    } else {
      startAfterDocSnap = docs[docs.length - 1];
      await sleepFn(BATCH_SLEEP_MS);
    }
  }

  // Flush bulkWriter.
  if (bulkWriter) {
    try {
      await bulkWriter.close();
    } catch (err) {
      summary.errors += 1;
      summary.error_details.push({ stage: 'bulkwriter_close', message: err.message });
      // eslint-disable-next-line no-console
      console.error(`[cassini-backfill] bulkwriter close failed: ${err.message}`);
    }
  }

  // Mark completion in cursor doc.
  if (!args.dryRun) {
    await writeCursor(firestore, args.tenantId, {
      lastDocId: summary.last_doc_id,
      processedCount: summary.processed,
      pages: summary.pages,
      completedAtIso: new Date(typeof now === 'function' ? now() : Date.now()).toISOString(),
    });
  }

  summary.completed_at = new Date(typeof now === 'function' ? now() : Date.now()).toISOString();
  return summary;
}

// -------------------------------------------------------------------------
// CLI entry-point.
// -------------------------------------------------------------------------

function writeSummary(summary, outPath = SUMMARY_PATH) {
  try {
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[cassini-backfill] writeSummary failed: ${err.message}`);
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.tenantId) {
    // eslint-disable-next-line no-console
    console.error('[cassini-backfill] ERROR: --tenant <tenantId> is mandatory.');
    printHelp();
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[cassini-backfill] tenant=${args.tenantId} mode=${args.apply ? 'APPLY' : 'DRY_RUN'} ` +
      `batchSize=${args.batchSize} days=${args.days} resume=${args.resume}`
  );

  const { firestore, error: fsErr } = tryLoadFirestore();
  if (fsErr) {
    // eslint-disable-next-line no-console
    console.warn(`[cassini-backfill] firestore unavailable: ${fsErr}`);
  }
  const { scoreProductCassini, error: scErr } = tryLoadScorer();
  if (scErr) {
    // eslint-disable-next-line no-console
    console.warn(`[cassini-backfill] cassini-scorer unavailable: ${scErr}`);
  }

  let summary;
  try {
    summary = await runBackfill({ firestore, scoreProductCassini, args });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[cassini-backfill] fatal: ${err.message}`);
    summary = {
      tenantId: args.tenantId,
      dryRun: args.dryRun,
      error: err.message,
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      processed: 0,
      skipped: 0,
      errors: 1,
      last_doc_id: null,
    };
    writeSummary(summary);
    process.exit(1);
  }

  writeSummary(summary);
  // eslint-disable-next-line no-console
  console.log(
    `[cassini-backfill] done. processed=${summary.processed} skipped=${summary.skipped} ` +
      `errors=${summary.errors} pages=${summary.pages} last=${summary.last_doc_id || 'n/a'} ` +
      `stub=${summary.stub_mode ? 'yes' : 'no'}`
  );
  process.exit(summary.errors > 0 && !summary.stub_mode ? 1 : 0);
}

// Only run when invoked directly (so tests can require() without side-effects).
if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  isoFromDaysAgo,
  pickPipelineKey,
  alreadyHasCassini,
  buildUpdateForProduct,
  buildBaseQuery,
  runBackfill,
  readCursor,
  writeCursor,
  writeSummary,
  SUMMARY_PATH,
  DEFAULT_BATCH_SIZE,
  DEFAULT_DAYS,
  STATE_COLLECTION,
  STATE_SUBCOLLECTION,
  PRODUCTS_COLLECTION,
};
