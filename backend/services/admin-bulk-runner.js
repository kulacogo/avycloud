const PQueue = require('p-queue').default || require('p-queue');
const { Timestamp, claimJob, updateJob, listJobsByStatus } = require('../lib/admin-bulk-jobs');
const { runBulkAction } = require('./admin-bulk-actions');

const CONCURRENCY = parseInt(process.env.ADMIN_BULK_QUEUE_CONCURRENCY || '1', 10);
const MAX_ATTEMPTS = parseInt(process.env.ADMIN_BULK_JOB_MAX_ATTEMPTS || '1', 10);
const JOB_SWEEP_INTERVAL_MS = parseInt(process.env.ADMIN_BULK_JOB_SWEEP_MS || '45000', 10);
const queue = new PQueue({ concurrency: CONCURRENCY });
let sweepTimer = null;
let sweepInFlight = false;

async function processAdminBulkJob(jobId) {
  let jobSnapshot;
  try {
    jobSnapshot = await claimJob(jobId);
  } catch (error) {
    if (error.message === 'Job not pending' || error.message === 'Job not found') {
      return;
    }
    console.error(`Failed to claim admin bulk job ${jobId}:`, error);
    return;
  }

  const action = jobSnapshot?.payload?.action || jobSnapshot?.action;
  console.log(`[AdminBulkRunner] Starting job ${jobId} action=${action}...`);

  try {
    await updateJob(jobId, { stage: 'running', updatedAt: Timestamp.now() });
    const startedAt = Date.now();
    const result = await runBulkAction(action, { ...(jobSnapshot.payload || {}), jobId });
    const elapsedMs = Date.now() - startedAt;
    await updateJob(jobId, {
      status: 'done',
      stage: 'complete',
      finishedAt: Timestamp.now(),
      result: { ...result, elapsedMs },
      error: null,
    });
    console.log(`[AdminBulkRunner] Job ${jobId} COMPLETED in ${elapsedMs}ms.`);
  } catch (error) {
    console.error(`[AdminBulkRunner] Job ${jobId} failed:`, error);
    const attempts = jobSnapshot.attempts || 1;
    const shouldRetry = attempts < MAX_ATTEMPTS;
    await updateJob(jobId, {
      status: shouldRetry ? 'pending' : 'failed',
      error: {
        message: error.message,
        stack: error.stack?.slice(0, 1200),
      },
      finishedAt: shouldRetry ? null : Timestamp.now(),
    });
  }
}

function enqueueAdminBulkJob(jobId, silent = false) {
  queue.add(() =>
    processAdminBulkJob(jobId).catch((error) => {
      if (!silent) {
        console.error(`Unexpected error in admin bulk queue for job ${jobId}:`, error);
      }
    })
  );
}

async function resumePendingAdminBulkJobs() {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    const jobs = await listJobsByStatus(['pending', 'processing']);
    if (!jobs.length) return;
    for (const job of jobs) {
      if (job.status === 'processing') {
        await updateJob(job.id, { status: 'pending', startedAt: null });
      }
      enqueueAdminBulkJob(job.id, true);
    }
    console.log(`Admin bulk runner resumed ${jobs.length} pending jobs`);
  } catch (error) {
    console.error('Failed to resume pending admin bulk jobs:', error);
  } finally {
    sweepInFlight = false;
  }
}

function startAdminBulkRunner() {
  resumePendingAdminBulkJobs().catch((error) => {
    console.error('Initial admin bulk resume failed:', error);
  });
  if (sweepTimer || JOB_SWEEP_INTERVAL_MS <= 0) {
    return;
  }
  sweepTimer = setInterval(() => {
    resumePendingAdminBulkJobs().catch((error) => {
      console.error('Scheduled admin bulk resume failed:', error);
    });
  }, JOB_SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') {
    sweepTimer.unref();
  }
}

module.exports = {
  enqueueAdminBulkJob,
  startAdminBulkRunner,
  resumePendingAdminBulkJobs,
};

