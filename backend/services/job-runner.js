const PQueue = require('p-queue').default || require('p-queue');
const { Timestamp, claimJob, updateJob, listJobsByStatus } = require('../lib/jobs');
const { downloadFile } = require('../lib/storage');
const { runProductIdentification } = require('./enrichment');
const {
  saveProduct,
  getProduct,
  findProductByIdentityKey,
  findProductByIdentityAliases,
} = require('../lib/firestore');
const { ensureProductSku } = require('../lib/sku');
const { computeProductIdentityKey, buildIdentityAliasSet } = require('../lib/product-identity');

const CONCURRENCY = parseInt(process.env.ID_QUEUE_CONCURRENCY || '3', 10);
const MAX_ATTEMPTS = parseInt(process.env.ID_JOB_MAX_ATTEMPTS || '3', 10);
const JOB_SWEEP_INTERVAL_MS = parseInt(process.env.ID_JOB_SWEEP_MS || '30000', 10);
const ALIAS_QUERY_LIMIT = parseInt(process.env.IDENTITY_ALIAS_QUERY_LIMIT || '10', 10);
const queue = new PQueue({ concurrency: CONCURRENCY });
let sweepTimer = null;
let sweepInFlight = false;

function buildDedupeKey(product) {
  const identity = computeProductIdentityKey(product);
  if (identity) return `identity:${identity}`;
  const sku =
    product?.details?.identifiers?.sku ||
    product?.identification?.sku ||
    product?.identification?.barcodes?.[0];
  if (sku) {
    return `sku:${String(sku).trim().toLowerCase()}`;
  }
  const normalizedName = (product?.identification?.name || '').trim().toLowerCase();
  if (normalizedName) {
    return `name:${normalizedName}`;
  }
  return `id:${product?.id || Math.random().toString(36).slice(2)}`;
}

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

    // Auto-Save identifizierte Produkte
    if (result?.bundle?.products?.length) {
      const dedupeKeys = new Set();
      for (const product of result.bundle.products) {
        try {
          ensureProductSku(product);

          product.ops = {
            ...(product.ops || {}),
            sync_status: 'pending',
            last_synced_iso: null,
          };
          const aliasSet = buildIdentityAliasSet(product);
          if (aliasSet.length) {
            product.ops.identity_aliases = aliasSet;
          }
          let matchedExistingProduct = null;

          const identityKey = computeProductIdentityKey(product);
          const isTemporaryId = typeof product.id === 'string' && /^prod-/i.test(product.id);
          const hasBarcode = Array.isArray(product.identification?.barcodes) && product.identification.barcodes.length > 0;

          if (identityKey && isTemporaryId && !hasBarcode) {
            const existingByIdentity = await findProductByIdentityKey(identityKey);
            if (existingByIdentity?.id) {
              product.id = existingByIdentity.id;
              matchedExistingProduct = existingByIdentity;
            }
          }

          // Avoid overwriting unrelated products: if same ID exists with abweichendem Barcode -> create new ID
          if (product.id) {
            const existing = await getProduct(product.id);
            if (existing && Array.isArray(existing.identification?.barcodes) && Array.isArray(product.identification?.barcodes)) {
              const existingBarcode = existing.identification.barcodes[0] || null;
              const incomingBarcode = product.identification.barcodes[0] || null;
              if (existingBarcode && incomingBarcode && existingBarcode !== incomingBarcode) {
                product.id = `${product.id}-${Date.now()}`;
              }
            }
          }

          if (!matchedExistingProduct && (product.ops.identity_aliases?.length || aliasSet.length)) {
            const aliasesToQuery = product.ops.identity_aliases?.length ? product.ops.identity_aliases : aliasSet;
            const aliasMatch = await findProductByIdentityAliases(aliasesToQuery, {
              excludeProductId: product.id,
              maxQueries: ALIAS_QUERY_LIMIT,
            });
            if (aliasMatch?.id) {
              product.id = aliasMatch.id;
              matchedExistingProduct = aliasMatch;
              const mergedAliases = Array.from(
                new Set([
                  ...(aliasMatch.ops?.identity_aliases || []),
                  ...(product.ops.identity_aliases || []),
                ])
              ).slice(0, 100);
              if (mergedAliases.length) {
                product.ops.identity_aliases = mergedAliases;
              }
              console.log(
                `Resolved duplicate product candidate via alias-set match for ${aliasMatch.id} (job ${jobId})`
              );
            }
          }

          if (matchedExistingProduct?.ops?.identity_aliases?.length && product.ops.identity_aliases?.length) {
            const mergedAliases = Array.from(
              new Set([
                ...matchedExistingProduct.ops.identity_aliases,
                ...product.ops.identity_aliases,
              ])
            ).slice(0, 100);
            product.ops.identity_aliases = mergedAliases;
          }

          const dedupeKey = buildDedupeKey(product);
          if (dedupeKeys.has(dedupeKey)) {
            console.log(`Skipping duplicate product candidate (${dedupeKey}) for job ${jobId}`);
            continue;
          }
          dedupeKeys.add(dedupeKey);

          await saveProduct(product);
        } catch (saveError) {
          console.error(`Auto-Save failed for product ${product?.id || 'unknown'} in job ${jobId}:`, saveError);
        }
      }
    }

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
        await updateJob(job.id, { status: 'pending' });
      }
      enqueueJob(job.id, true);
    }
    console.log(`Job runner resumed ${jobs.length} pending jobs`);
  } catch (error) {
    console.error('Failed to resume pending jobs:', error);
  } finally {
    sweepInFlight = false;
  }
}

function startJobRunner() {
  resumePendingJobs().catch((error) => {
    console.error('Initial job resume failed:', error);
  });
  if (sweepTimer || JOB_SWEEP_INTERVAL_MS <= 0) {
    return;
  }
  sweepTimer = setInterval(() => {
    resumePendingJobs().catch((error) => {
      console.error('Scheduled job resume failed:', error);
    });
  }, JOB_SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') {
    sweepTimer.unref();
  }
}

module.exports = {
  enqueueJob,
  resumePendingJobs,
  startJobRunner,
};
