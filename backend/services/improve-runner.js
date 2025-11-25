const PQueue = require('p-queue').default || require('p-queue');
const { Timestamp, claimJob, updateJob, listJobsByStatus } = require('../lib/improve-jobs');
const { improveExistingProduct } = require('./improve');

const CONCURRENCY = parseInt(process.env.IMPROVE_QUEUE_CONCURRENCY || '2', 10);
const MAX_ATTEMPTS = parseInt(process.env.IMPROVE_JOB_MAX_ATTEMPTS || '2', 10);
const queue = new PQueue({ concurrency: CONCURRENCY });

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
  try {
    const jobs = await listJobsByStatus(['pending', 'processing']);
    for (const job of jobs) {
      if (job.status === 'processing') {
        await updateJob(job.id, { status: 'pending', startedAt: null });
      }
      enqueueImproveJob(job.id, true);
    }
    if (jobs.length) {
      console.log(`Improve runner resumed ${jobs.length} pending jobs`);
    }
  } catch (error) {
    console.error('Failed to resume pending improve jobs:', error);
  }
}

module.exports = {
  enqueueImproveJob,
  resumePendingImproveJobs,
};


