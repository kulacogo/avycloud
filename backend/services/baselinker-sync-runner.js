const PQueue = require('p-queue').default || require('p-queue');
const { Timestamp, claimJob, updateJob, listJobsByStatus } = require('../lib/baselinker-sync-jobs');
const { getProduct } = require('../lib/firestore');
const { syncProductsToBaseLinker } = require('../lib/baselinker');

const CONCURRENCY = parseInt(process.env.BASELINKER_JOB_CONCURRENCY || '1', 10);
const MAX_ATTEMPTS = parseInt(process.env.BASELINKER_JOB_MAX_ATTEMPTS || '2', 10);
const JOB_SWEEP_INTERVAL_MS = parseInt(process.env.BASELINKER_JOB_SWEEP_MS || '45000', 10);
const JOB_RETRY_BACKOFF_MS = parseInt(process.env.BASELINKER_JOB_BACKOFF_MS || '30000', 10);

const queue = new PQueue({ concurrency: CONCURRENCY });
let sweepTimer = null;
let sweepInFlight = false;

async function processBaseLinkerSyncJob(jobId) {
  let jobSnapshot;
  try {
    jobSnapshot = await claimJob(jobId);
  } catch (error) {
    if (error.message === 'Job not pending' || error.message === 'Job not found') return;
    console.error(`Failed to claim BaseLinker sync job ${jobId}:`, error);
    return;
  }

  try {
    const invId = String(jobSnapshot?.payload?.inventoryId || process.env.BASELINKER_INVENTORY_ID || '78659').trim();
    const productIds = Array.isArray(jobSnapshot?.payload?.productIds) ? jobSnapshot.payload.productIds : [];
    const mode = (jobSnapshot?.payload?.mode || 'full').toString().trim().toLowerCase();
    if (!productIds.length) {
      throw new Error('Job payload has no productIds');
    }

    await updateJob(jobId, {
      stage: 'loading_products',
      progress: { total: productIds.length, processed: 0, synced: 0, failed: 0 },
      updatedAt: Timestamp.now(),
    });

    const products = [];
    for (const id of productIds) {
      const p = await getProduct(String(id)).catch(() => null);
      if (p) products.push(p);
    }

    await updateJob(jobId, {
      stage: 'syncing',
      progress: { total: productIds.length, processed: 0, synced: 0, failed: 0 },
    });

    let processed = 0;
    let synced = 0;
    let failed = 0;
    const lastFlush = { at: 0 };
    const flushEveryMs = 1500;

    const results = await syncProductsToBaseLinker(products, invId, {
      mode,
      onProgress: async ({ result }) => {
        processed += 1;
        if (result?.status === 'synced') synced += 1;
        if (result?.status === 'failed') failed += 1;
        const now = Date.now();
        if (now - lastFlush.at > flushEveryMs || processed === products.length) {
          lastFlush.at = now;
          await updateJob(jobId, {
            stage: 'syncing',
            progress: { total: productIds.length, processed, synced, failed },
          });
        }
      },
    });

    await updateJob(jobId, {
      status: failed > 0 ? 'failed' : 'done',
      stage: 'complete',
      finishedAt: Timestamp.now(),
      progress: { total: productIds.length, processed: productIds.length, synced, failed },
      result: { inventoryId: invId, results },
      error: failed > 0 ? { message: `Some products failed (${failed}/${productIds.length})` } : null,
    });
  } catch (error) {
    console.error(`BaseLinker sync job ${jobId} failed:`, error);
    const attempts = jobSnapshot.attempts || 1;
    const shouldRetry = attempts < MAX_ATTEMPTS;
    await updateJob(jobId, {
      status: shouldRetry ? 'pending' : 'failed',
      stage: shouldRetry ? 'queued' : 'failed',
      error: { message: error.message, stack: error.stack?.slice(0, 1000) },
      finishedAt: shouldRetry ? null : Timestamp.now(),
    });
    if (shouldRetry) {
      const backoff = JOB_RETRY_BACKOFF_MS * (attempts || 1);
      setTimeout(() => enqueueBaseLinkerSyncJob(jobId, true), backoff);
    }
  }
}

function enqueueBaseLinkerSyncJob(jobId, silent = false) {
  queue.add(() =>
    processBaseLinkerSyncJob(jobId).catch((error) => {
      if (!silent) {
        console.error(`Unexpected error in BaseLinker sync queue for job ${jobId}:`, error);
      }
    })
  );
}

async function resumePendingBaseLinkerSyncJobs() {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    const jobs = await listJobsByStatus(['pending', 'processing']);
    if (!jobs.length) return;
    for (const job of jobs) {
      if (job.status === 'processing') {
        await updateJob(job.id, { status: 'pending', startedAt: null, stage: 'queued' });
      }
      enqueueBaseLinkerSyncJob(job.id, true);
    }
    console.log(`BaseLinker sync runner resumed ${jobs.length} pending jobs`);
  } catch (error) {
    console.error('Failed to resume pending BaseLinker sync jobs:', error);
  } finally {
    sweepInFlight = false;
  }
}

function startBaseLinkerSyncRunner() {
  resumePendingBaseLinkerSyncJobs().catch((error) => {
    console.error('Initial BaseLinker sync resume failed:', error);
  });
  if (sweepTimer || JOB_SWEEP_INTERVAL_MS <= 0) return;
  sweepTimer = setInterval(() => {
    resumePendingBaseLinkerSyncJobs().catch((error) => {
      console.error('Scheduled BaseLinker sync resume failed:', error);
    });
  }, JOB_SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') {
    sweepTimer.unref();
  }
}

module.exports = {
  enqueueBaseLinkerSyncJob,
  resumePendingBaseLinkerSyncJobs,
  startBaseLinkerSyncRunner,
};

