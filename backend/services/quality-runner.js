const PQueue = require('p-queue').default || require('p-queue');
const { Timestamp, claimJob, updateJob, listJobsByStatus } = require('../lib/quality-jobs');
const { runQualityGateForProduct } = require('./quality-gate');

const CONCURRENCY = parseInt(process.env.QUALITY_QUEUE_CONCURRENCY || '2', 10);
const MAX_ATTEMPTS = parseInt(process.env.QUALITY_JOB_MAX_ATTEMPTS || '2', 10);
const JOB_SWEEP_INTERVAL_MS = parseInt(process.env.QUALITY_JOB_SWEEP_MS || '45000', 10);
const JOB_RETRY_BACKOFF_MS = parseInt(process.env.QUALITY_JOB_BACKOFF_MS || '30000', 10);

const queue = new PQueue({ concurrency: CONCURRENCY });
let sweepTimer = null;
let sweepInFlight = false;

async function processQualityJob(jobId) {
  let jobSnapshot;
  try {
    jobSnapshot = await claimJob(jobId);
  } catch (error) {
    if (error.message === 'Job not pending' || error.message === 'Job not found') {
      return;
    }
    console.error(`Failed to claim quality job ${jobId}:`, error);
    return;
  }

  console.log(`[QualityRunner] Starting job ${jobId} (Product: ${jobSnapshot.productId})...`);

  try {
    const productId = jobSnapshot.productId || jobSnapshot.payload?.productId;
    if (!productId) {
      throw new Error('Job has no productId payload');
    }

    await updateJob(jobId, { stage: 'running', updatedAt: Timestamp.now() });
    const result = await runQualityGateForProduct(productId, {
      locale: jobSnapshot.locale || 'de-DE',
      reason: jobSnapshot.reason || 'auto',
      requestedBy: jobSnapshot.requestedBy || 'system',
      force: Boolean(jobSnapshot.force),
    });

    await updateJob(jobId, {
      status: 'done',
      stage: 'complete',
      finishedAt: Timestamp.now(),
      result,
      error: null,
    });
  } catch (error) {
    console.error(`Quality job ${jobId} failed:`, error);
    const attempts = jobSnapshot.attempts || 1;
    const shouldRetry = attempts < MAX_ATTEMPTS;
    await updateJob(jobId, {
      status: shouldRetry ? 'pending' : 'failed',
      error: { message: error.message, stack: error.stack?.slice(0, 1000) },
      finishedAt: shouldRetry ? null : Timestamp.now(),
    });
    if (shouldRetry) {
      const backoff = JOB_RETRY_BACKOFF_MS * (attempts || 1);
      setTimeout(() => enqueueQualityJob(jobId, true), backoff);
    }
  }
}

function enqueueQualityJob(jobId, silent = false) {
  queue.add(() =>
    processQualityJob(jobId).catch((error) => {
      if (!silent) {
        console.error(`Unexpected error in quality queue for job ${jobId}:`, error);
      }
    })
  );
}

async function resumePendingQualityJobs() {
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
      enqueueQualityJob(job.id, true);
    }
    console.log(`Quality runner resumed ${jobs.length} pending jobs`);
  } catch (error) {
    console.error('Failed to resume pending quality jobs:', error);
  } finally {
    sweepInFlight = false;
  }
}

function startQualityRunner() {
  resumePendingQualityJobs().catch((error) => {
    console.error('Initial quality resume failed:', error);
  });
  if (sweepTimer || JOB_SWEEP_INTERVAL_MS <= 0) {
    return;
  }
  sweepTimer = setInterval(() => {
    resumePendingQualityJobs().catch((error) => {
      console.error('Scheduled quality resume failed:', error);
    });
  }, JOB_SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') {
    sweepTimer.unref();
  }
}

module.exports = {
  enqueueQualityJob,
  resumePendingQualityJobs,
  startQualityRunner,
};

