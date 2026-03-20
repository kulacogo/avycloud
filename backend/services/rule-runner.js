'use strict';

/**
 * rule-runner.js — Job runner for automation rules (RULE-001).
 *
 * Follows the same pattern as rulebook-runner.js:
 * p-queue for concurrency, Firestore job queue, claim+process+update cycle.
 */

const PQueue = require('p-queue').default || require('p-queue');
const { Firestore, FieldValue } = require('@google-cloud/firestore');
const { saveProductV2 } = require('../lib/product-store');
const {
  evaluateConditions,
  applyActions,
  RULES_COLLECTION,
  JOBS_COLLECTION,
  PRODUCTS_COLLECTION,
  getDb,
} = require('./rule-engine');

const CONCURRENCY = parseInt(process.env.RULE_JOB_CONCURRENCY || '1', 10);
const MAX_ATTEMPTS = parseInt(process.env.RULE_JOB_MAX_ATTEMPTS || '2', 10);
const SWEEP_INTERVAL_MS = parseInt(process.env.RULE_JOB_SWEEP_MS || '45000', 10);
const BATCH_SIZE = 200;

const queue = new PQueue({ concurrency: CONCURRENCY });
let sweepTimer = null;
let sweepInFlight = false;

/* ─── Job Claim (Firestore Transaction) ─── */

async function claimJob(jobId) {
  const db = getDb();
  const jobRef = db.collection(JOBS_COLLECTION).doc(jobId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    if (!snap.exists) throw new Error('Job not found');
    const data = snap.data();
    if (data.status !== 'pending') throw new Error('Job not pending');
    if (data.attempts >= MAX_ATTEMPTS) throw new Error('Max attempts exceeded');
    tx.update(jobRef, {
      status: 'processing',
      attempts: FieldValue.increment(1),
      updatedAt: new Date().toISOString(),
    });
    return { id: snap.id, ...data };
  });
}

/* ─── Process a Single Job ─── */

async function processAutomationJob(jobId) {
  let job;
  try {
    job = await claimJob(jobId);
  } catch (err) {
    if (err.message === 'Job not pending' || err.message === 'Job not found') return;
    console.error(`[rule-runner] Failed to claim job ${jobId}: ${err.message}`);
    return;
  }

  const db = getDb();
  const jobRef = db.collection(JOBS_COLLECTION).doc(jobId);

  try {
    // Load rule
    const ruleSnap = await db.collection(RULES_COLLECTION).doc(job.ruleId).get();
    if (!ruleSnap.exists) throw new Error('Rule not found');
    const rule = ruleSnap.data();

    // Load products in chunks
    const tenantId = job.tenantId || 'default';
    let allProducts = [];
    let lastDoc = null;

    while (true) {
      let query = db.collection(PRODUCTS_COLLECTION)
        .where('tenantId', '==', tenantId)
        .limit(BATCH_SIZE);
      if (lastDoc) query = query.startAfter(lastDoc);
      const snap = await query.get();
      if (snap.empty) break;
      allProducts = allProducts.concat(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      lastDoc = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < BATCH_SIZE) break;
    }

    const progress = { total: allProducts.length, processed: 0, applied: 0, skipped: 0, errors: 0 };
    const changes = []; // first 100 changes for preview

    // Process each product
    for (const product of allProducts) {
      try {
        if (!evaluateConditions(product, rule.conditions)) {
          progress.skipped++;
          progress.processed++;
          continue;
        }

        // Deep-clone product for action application
        const productCopy = JSON.parse(JSON.stringify(product));
        const productChanges = applyActions(productCopy, rule.actions);

        if (productChanges.length === 0) {
          progress.skipped++;
          progress.processed++;
          continue;
        }

        if (job.mode === 'execute') {
          await saveProductV2(product.id, productCopy, { tenantId, source: `rule:${job.ruleId}` });
        }

        progress.applied++;
        if (changes.length < 100) {
          for (const c of productChanges) {
            changes.push({
              productId: product.id,
              productName: product.identification?.name || product.name || product.id,
              ...c,
            });
          }
        }
      } catch (err) {
        progress.errors++;
        console.warn(`[rule-runner] Error processing product ${product.id}: ${err.message}`);
      }
      progress.processed++;

      // Update progress periodically (every 50 products)
      if (progress.processed % 50 === 0) {
        await jobRef.update({ progress, updatedAt: new Date().toISOString() }).catch(() => {});
      }
    }

    // Finalize job
    const summary = `${progress.applied}/${progress.total} Produkte ${job.mode === 'execute' ? 'geändert' : 'würden geändert'} (${progress.skipped} übersprungen, ${progress.errors} Fehler)`;
    await jobRef.update({
      status: 'done',
      progress,
      result: { summary, changes: changes.slice(0, 100) },
      updatedAt: new Date().toISOString(),
    });

    // Update rule stats
    if (job.mode === 'execute') {
      await db.collection(RULES_COLLECTION).doc(job.ruleId).update({
        'stats.lastRunAt': new Date().toISOString(),
        'stats.lastRunProducts': progress.total,
        'stats.lastRunApplied': progress.applied,
        'stats.totalRuns': FieldValue.increment(1),
        updatedAt: new Date().toISOString(),
      }).catch(() => {});
    }

    console.log(`[rule-runner] Job ${jobId} done: ${summary}`);
  } catch (err) {
    console.error(`[rule-runner] Job ${jobId} failed: ${err.message}`);
    await jobRef.update({
      status: 'failed',
      error: err.message,
      updatedAt: new Date().toISOString(),
    }).catch(() => {});
  }
}

/* ─── Queue Management ─── */

function enqueueAutomationJob(jobId) {
  queue.add(() => processAutomationJob(jobId));
}

async function resumePendingAutomationJobs() {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    const db = getDb();
    const pending = await db.collection(JOBS_COLLECTION)
      .where('status', 'in', ['pending', 'processing'])
      .orderBy('createdAt', 'asc')
      .limit(20)
      .get();

    for (const doc of pending.docs) {
      const data = doc.data();
      if (data.status === 'processing' && data.attempts >= MAX_ATTEMPTS) continue;
      enqueueAutomationJob(doc.id);
    }
  } catch (err) {
    console.warn(`[rule-runner] Sweep failed: ${err.message}`);
  } finally {
    sweepInFlight = false;
  }
}

function startRuleRunner() {
  console.log(`[rule-runner] Starting — concurrency: ${CONCURRENCY}, sweep: ${SWEEP_INTERVAL_MS}ms`);
  resumePendingAutomationJobs();
  sweepTimer = setInterval(() => resumePendingAutomationJobs(), SWEEP_INTERVAL_MS);
}

function stopRuleRunner() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

module.exports = {
  processAutomationJob,
  enqueueAutomationJob,
  resumePendingAutomationJobs,
  startRuleRunner,
  stopRuleRunner,
};
