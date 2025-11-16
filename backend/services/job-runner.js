const PQueue = require('p-queue').default || require('p-queue');
const { Timestamp, claimJob, updateJob, listJobsByStatus } = require('../lib/jobs');
const { downloadFile } = require('../lib/storage');
const { runProductIdentification } = require('./enrichment');

const CONCURRENCY = parseInt(process.env.ID_QUEUE_CONCURRENCY || '3', 10);
const MAX_ATTEMPTS = parseInt(process.env.ID_JOB_MAX_ATTEMPTS || '3', 10);
const queue = new PQueue({ concurrency: CONCURRENCY });

async function processJob(jobId) {
  let jobSnapshot;
  try {
    jobSnapshot = await claimJob(jobId);
  } catch (error) {
    if (error.message === 'Job not pending' || error.message === 'Job not found') {
      return;
    }
    console.error(`Failed to claim job ${jobId}:`, error);
    return;
  }

  try {
    const filesMeta = jobSnapshot.payload?.files || [];
    if (!filesMeta.length) {
      throw new Error('Job has no files to process');
    }

    const files = await Promise.all(
      filesMeta.map(async (fileMeta) => {
        const fileData = await downloadFile(fileMeta.path);
        return {
          fieldname: 'images',
          originalname: fileMeta.originalName || 'upload',
          encoding: '7bit',
          mimetype: fileMeta.mimeType || 'application/octet-stream',
          size: fileData.size,
          buffer: fileData.buffer,
        };
      })
    );

    const result = await runProductIdentification({
      files,
      barcodes: jobSnapshot.payload?.barcodes || '',
      locale: jobSnapshot.payload?.locale || 'de-DE',
      modelOverride: jobSnapshot.payload?.model || null,
    });

    await updateJob(jobId, {
      status: 'done',
      finishedAt: Timestamp.now(),
      result: result.bundle,
      serpTrace: result.serpTrace,
      modelUsed: result.modelResponse?.model || result.modelUsed || null,
    });
  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);
    const attempts = jobSnapshot.attempts || 1;
    const shouldRetry = attempts < MAX_ATTEMPTS;
    await updateJob(jobId, {
      status: shouldRetry ? 'pending' : 'failed',
      error: {
        message: error.message,
        stack: error.stack?.slice(0, 1000),
      },
    });

    if (shouldRetry) {
      enqueueJob(jobId, true);
    }
  }
}

function enqueueJob(jobId, silent = false) {
  queue.add(() =>
    processJob(jobId).catch((error) => {
      if (!silent) {
        console.error(`Unexpected error in queue for job ${jobId}:`, error);
      }
    })
  );
}

async function resumePendingJobs() {
  try {
    const jobs = await listJobsByStatus(['pending', 'processing']);
    for (const job of jobs) {
      if (job.status === 'processing') {
        await updateJob(job.id, { status: 'pending' });
      }
      enqueueJob(job.id, true);
    }
    console.log(`Job runner resumed ${jobs.length} pending jobs`);
  } catch (error) {
    console.error('Failed to resume pending jobs:', error);
  }
}

module.exports = {
  enqueueJob,
  resumePendingJobs,
};

