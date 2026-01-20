const PQueue = require('p-queue').default || require('p-queue');
const { Timestamp, claimJob, updateJob, listJobsByStatus } = require('../lib/bigcommerce-sync-jobs');
const { getProduct, updateProductBigCommerceSyncStatus } = require('../lib/firestore');
const { syncProductsToBigCommerce } = require('../lib/bigcommerce');

const CONCURRENCY = parseInt(process.env.BIGCOMMERCE_JOB_CONCURRENCY || '1', 10);
const MAX_ATTEMPTS = parseInt(process.env.BIGCOMMERCE_JOB_MAX_ATTEMPTS || '2', 10);
const JOB_SWEEP_INTERVAL_MS = parseInt(process.env.BIGCOMMERCE_JOB_SWEEP_MS || '45000', 10);
const JOB_RETRY_BACKOFF_MS = parseInt(process.env.BIGCOMMERCE_JOB_BACKOFF_MS || '30000', 10);

const queue = new PQueue({ concurrency: CONCURRENCY });
let sweepTimer = null;
let sweepInFlight = false;

async function processBigCommerceSyncJob(jobId) {
  let jobSnapshot;
  try {
    jobSnapshot = await claimJob(jobId);
  } catch (error) {
    if (error.message === 'Job not pending' || error.message === 'Job not found') return;
    console.error(`Failed to claim BigCommerce sync job ${jobId}:`, error);
    return;
  }

  try {
    const productIds = Array.isArray(jobSnapshot?.payload?.productIds) ? jobSnapshot.payload.productIds : [];
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
      // eslint-disable-next-line no-await-in-loop
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

    const results = await syncProductsToBigCommerce(products, {
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

        // Best-effort: persist linkage/status back into Firestore product doc
        try {
          if (result?.id) {
            await updateProductBigCommerceSyncStatus(
              String(result.id),
              result.status,
              result.status === 'synced' ? new Date().toISOString() : null,
              result.bigcommerce_product_id
            );
          }
        } catch (e) {
          // Never fail the whole job due to metadata write
          console.warn('[bigcommerce-sync-runner] failed to persist sync status:', e?.message || e);
        }
      },
    });

    await updateJob(jobId, {
      status: failed > 0 ? 'failed' : 'done',
      stage: 'complete',
      finishedAt: Timestamp.now(),
      progress: { total: productIds.length, processed: productIds.length, synced, failed },
      result: { results },
      error: failed > 0 ? { message: `Some products failed (${failed}/${productIds.length})` } : null,
    });
  } catch (error) {
    console.error(`BigCommerce sync job ${jobId} failed:`, error);
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
      setTimeout(() => enqueueBigCommerceSyncJob(jobId, true), backoff);
    }
  }
}

function enqueueBigCommerceSyncJob(jobId, silent = false) {
  queue.add(() =>
    processBigCommerceSyncJob(jobId).catch((error) => {
      if (!silent) {
        console.error(`Unexpected error in BigCommerce sync queue for job ${jobId}:`, error);
      }
    })
  );
}

async function resumePendingBigCommerceSyncJobs() {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    const jobs = await listJobsByStatus(['pending', 'processing']);
    if (!jobs.length) return;
    for (const job of jobs) {
      if (job.status === 'processing') {
        await updateJob(job.id, { status: 'pending', startedAt: null, stage: 'queued' });
      }
      enqueueBigCommerceSyncJob(job.id, true);
    }
    console.log(`BigCommerce sync runner resumed ${jobs.length} pending jobs`);
  } catch (error) {
    console.error('Failed to resume pending BigCommerce sync jobs:', error);
  } finally {
    sweepInFlight = false;
  }
}

function startBigCommerceSyncRunner() {
  resumePendingBigCommerceSyncJobs().catch((error) => {
    console.error('Initial BigCommerce sync resume failed:', error);
  });
  if (sweepTimer || JOB_SWEEP_INTERVAL_MS <= 0) return;
  sweepTimer = setInterval(() => {
    resumePendingBigCommerceSyncJobs().catch((error) => {
      console.error('Scheduled BigCommerce sync resume failed:', error);
    });
  }, JOB_SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') {
    sweepTimer.unref();
  }
}

module.exports = {
  enqueueBigCommerceSyncJob,
  resumePendingBigCommerceSyncJobs,
  startBigCommerceSyncRunner,
};

