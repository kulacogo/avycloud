const PQueue = require('p-queue').default || require('p-queue');
const { Timestamp, claimJob, updateJob, listJobsByStatus } = require('../lib/improve-jobs');
const { improveExistingProduct } = require('./improve');

const CONCURRENCY = parseInt(process.env.IMPROVE_QUEUE_CONCURRENCY || '2', 10);
const MAX_ATTEMPTS = parseInt(process.env.IMPROVE_JOB_MAX_ATTEMPTS || '2', 10);
const JOB_SWEEP_INTERVAL_MS = parseInt(process.env.IMPROVE_JOB_SWEEP_MS || '45000', 10);
const queue = new PQueue({ concurrency: CONCURRENCY });
let sweepTimer = null;
let sweepInFlight = false;

async function processImproveJob(jobId) {
  let jobSnapshot;
  try {
    jobSnapshot = await claimJob(jobId);
  } catch (error) {
    if (
      error.message === 'Job not pending' ||
      error.message === 'Job not found'
    ) {
      return;
    }
    console.error(`Failed to claim improve job ${jobId}:`, error);
    return;
  }

  try {
    const productId = jobSnapshot.productId || jobSnapshot.payload?.productId;
    if (!productId) {
      throw new Error('Job has no productId payload');
    }

    const improvedProduct = await improveExistingProduct(productId);
    await updateJob(jobId, {
      status: 'done',
      finishedAt: Timestamp.now(),
      result: { product: improvedProduct },
      error: null,
    });
  } catch (error) {
    console.error(`Improve job ${jobId} failed:`, error);
    const attempts = jobSnapshot.attempts || 1;
    const shouldRetry = attempts < MAX_ATTEMPTS;
    await updateJob(jobId, {
      status: shouldRetry ? 'pending' : 'failed',
      error: {
        message: error.message,
        stack: error.stack?.slice(0, 1000),
      },
      finishedAt: shouldRetry ? null : Timestamp.now(),
    });
    if (shouldRetry) {
      enqueueImproveJob(jobId, true);
    }
  }
}

function enqueueImproveJob(jobId, silent = false) {
  queue.add(() =>
    processImproveJob(jobId).catch((error) => {
      if (!silent) {
        console.error(`Unexpected error in improve queue for job ${jobId}:`, error);
      }
    })
  );
}

async function resumePendingImproveJobs() {
  if (sweepInFlight) {
    return;
  }
  sweepInFlight = true;
  try {
    const jobs = await listJobsByStatus(['pending', 'processing']);
    if (!jobs.length) {
      return;
    }
    for (const job of jobs) {
      if (job.status === 'processing') {
        await updateJob(job.id, { status: 'pending', startedAt: null });
      }
      enqueueImproveJob(job.id, true);
    }
    console.log(`Improve runner resumed ${jobs.length} pending jobs`);
  } catch (error) {
    console.error('Failed to resume pending improve jobs:', error);
  } finally {
    sweepInFlight = false;
  }
}

function startImproveRunner() {
  resumePendingImproveJobs().catch((error) => {
    console.error('Initial improve resume failed:', error);
  });
  if (sweepTimer || JOB_SWEEP_INTERVAL_MS <= 0) {
    return;
  }
  sweepTimer = setInterval(() => {
    resumePendingImproveJobs().catch((error) => {
      console.error('Scheduled improve resume failed:', error);
    });
  }, JOB_SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') {
    sweepTimer.unref();
  }
}

module.exports = {
  enqueueImproveJob,
  resumePendingImproveJobs,
  startImproveRunner,
};


