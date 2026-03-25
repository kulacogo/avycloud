const PQueue = require('p-queue').default || require('p-queue');
const { Timestamp, claimJob, updateJob, listJobsByStatus, moveToDeadLetter } = require('../lib/jobs');
const { downloadFile } = require('../lib/storage');
const { runProductIdentification } = require('./enrichment');
const { runProductIdentificationGrounding } = require('./identify-grounding');
const {
  getProduct,
  findProductByIdentityKey,
  findProductByIdentityAliases,
  findProductByStrictIdentifier, // Import new function
  findProductByNameBrand,
  adjustPendingIntakeQuantity,
  appendProductIdentityAliases,
  removeProductIdentityAliases,
  getInventoryRecord,
  setProductInventory,
} = require('../lib/firestore');
const { saveProductV2 } = require('../lib/product-store');
// SKU is allocated/validated centrally in saveProduct() (firestore) to guarantee uniqueness & format.
const { computeProductIdentityKey, buildIdentityAliasSet } = require('../lib/product-identity');
const { createJob: createQualityJob } = require('../lib/quality-jobs');
const { enqueueQualityJob } = require('./quality-runner');
const { evaluateEbayReady } = require('../lib/datasheet-quality');

const CONCURRENCY = parseInt(process.env.ID_QUEUE_CONCURRENCY || '3', 10);
const MAX_ATTEMPTS = parseInt(process.env.ID_JOB_MAX_ATTEMPTS || '3', 10);
const JOB_SWEEP_INTERVAL_MS = parseInt(process.env.ID_JOB_SWEEP_MS || '30000', 10);
const JOB_TIMEOUT_MS = parseInt(process.env.ID_JOB_TIMEOUT_MS || '300000', 10); // 5 min
const RETRY_BASE_DELAY_MS = parseInt(process.env.ID_JOB_RETRY_BASE_MS || '5000', 10);
const STALE_JOB_THRESHOLD_MS = parseInt(process.env.ID_JOB_STALE_MS || '600000', 10); // 10 min
const ALIAS_QUERY_LIMIT = parseInt(process.env.IDENTITY_ALIAS_QUERY_LIMIT || '10', 10);
const queue = new PQueue({ concurrency: CONCURRENCY });
let sweepTimer = null;
let sweepInFlight = false;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Job timeout after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const normalizeBarcodeValue = (value) =>
  (value || '')
    .toString()
    .replace(/\D+/g, '')
    .trim();

function hasMinimalIdentification(product = {}) {
  // kept for legacy debugging; Identify jobs now require ebay-ready outputs before saving.
  const name = product.identification?.name?.trim() || '';
  const hasName = name.length >= 3 && !/^unbekannt$/i.test(name);
  const hasImage =
    Array.isArray(product.details?.images) &&
    product.details.images.some((img) => img && (img.url_or_base64 || img.url || img.href));
  return hasName && hasImage;
}

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
    const inventoryId = jobSnapshot.payload?.inventoryId || null;
    const inventoryRecord = inventoryId ? await getInventoryRecord(inventoryId) : null;
    if (inventoryId && !inventoryRecord) {
      throw new Error(`Inventory ${inventoryId} wurde nicht gefunden.`);
    }

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

    const GROUNDING_ENABLED =
      String(process.env.IDENTIFY_GROUNDING || 'true').toLowerCase() === 'true';

    const identifyArgs = {
      files,
      barcodes: jobSnapshot.payload?.barcodes || '',
      locale: jobSnapshot.payload?.locale || 'de-DE',
      modelOverride: jobSnapshot.payload?.model || null,
      hint: jobSnapshot.payload?.hint || null,
    };

    let result;
    if (GROUNDING_ENABLED) {
      try {
        result = await withTimeout(
          runProductIdentificationGrounding(identifyArgs),
          JOB_TIMEOUT_MS,
          jobId
        );
      } catch (groundingError) {
        console.warn(`[job ${jobId}] Grounding pipeline failed, falling back to legacy:`, groundingError?.message);
        result = await withTimeout(
          runProductIdentification(identifyArgs),
          JOB_TIMEOUT_MS,
          jobId
        );
      }
    } else {
      result = await withTimeout(
        runProductIdentification(identifyArgs),
        JOB_TIMEOUT_MS,
        jobId
      );
    }

    // Auto-Save identifizierte Produkte
    if (result?.bundle?.products?.length) {
      const dedupeKeys = new Set();
      const reuseEvents = [];
      const bundleProducts = result.bundle.products;

      for (let index = 0; index < bundleProducts.length; index += 1) {
        const product = bundleProducts[index];
        try {
          // SKU is allocated/validated in saveProduct(); do not generate here to avoid diverging behavior.
          if (inventoryRecord) {
            product.inventory = {
              ...(product.inventory || {}),
              inventoryId: inventoryRecord.inventoryId,
              inventoryName: inventoryRecord.name || null,
            };
          }

          product.ops = {
            ...(product.ops || {}),
            sync_status: 'pending',
            last_synced_iso: null,
            pending_intake_quantity: product.ops?.pending_intake_quantity || 0,
          };
          const aliasSet = buildIdentityAliasSet(product);
          if (aliasSet.length) {
            product.ops.identity_aliases = aliasSet;
          }
          const normalizedProductBarcodes = Array.isArray(product.identification?.barcodes)
            ? product.identification.barcodes.map(normalizeBarcodeValue).filter(Boolean)
            : [];
          let matchedExistingProduct = null;
          let matchedProductId = null;

          const identityKey = computeProductIdentityKey(product);
          const isTemporaryId = typeof product.id === 'string' && /^prod-/i.test(product.id);
          const hasBarcode = Array.isArray(product.identification?.barcodes) && product.identification.barcodes.length > 0;
          const nameForMatch = (product.identification?.name || '').trim();
          const brandForMatch = (product.identification?.brand || '').trim();

          // 0. Hard safety: if the identified product ID already exists in Firestore, DO NOT overwrite it.
          // This can happen when `ensureProductId()` uses a barcode/EAN as the product id.
          // Identify is allowed to CREATE new products, but must never "reset" an existing datasheet.
          if (!matchedExistingProduct && product.id) {
            const existingById = await getProduct(String(product.id));
            if (existingById?.id) {
              matchedExistingProduct = existingById;
              matchedProductId = existingById.id;
              console.log(`Resolved duplicate product via ID collision: ${existingById.id} (job ${jobId})`);
            }
          }

          // 1. Strict Identifier Check (Barcode/SKU) - PRIORITY
          if (!matchedExistingProduct) {
             const strictMatch = await findProductByStrictIdentifier({
               barcodes: product.identification?.barcodes || [],
               sku: product.identification?.sku || product.details?.identifiers?.sku
             });
             if (strictMatch?.id) {
               matchedExistingProduct = strictMatch;
               matchedProductId = strictMatch.id;
               console.log(`Resolved duplicate product via STRICT identifier match: ${strictMatch.id} (job ${jobId})`);
             }
          }

          // 1b. Exact name match (optional brand filter) if no barcode/sku hit
          if (!matchedExistingProduct && nameForMatch) {
            const nameMatch = await findProductByNameBrand(nameForMatch, brandForMatch);
            if (nameMatch?.id) {
              matchedExistingProduct = nameMatch;
              matchedProductId = nameMatch.id;
              console.log(`Resolved duplicate product via NAME match: ${nameMatch.id} (job ${jobId})`);
            }
          }

          // 2. Identity Key Heuristic (for non-barcode products)
          if (!matchedExistingProduct && identityKey && isTemporaryId && !hasBarcode) {
            const existingByIdentity = await findProductByIdentityKey(identityKey);
            if (existingByIdentity?.id) {
              matchedExistingProduct = existingByIdentity;
              matchedProductId = existingByIdentity.id;
            }
          }

          // 3. Alias Heuristic
          if (
            !matchedExistingProduct &&
            (product.ops.identity_aliases?.length || aliasSet.length)
          ) {
            const aliasesToQuery = product.ops.identity_aliases?.length ? product.ops.identity_aliases : aliasSet;
            const aliasMatch = await findProductByIdentityAliases(aliasesToQuery, {
              excludeProductId: product.id,
              maxQueries: ALIAS_QUERY_LIMIT,
            });
            if (aliasMatch?.id) {
              const aliasMatchBarcodes = Array.isArray(aliasMatch.identification?.barcodes)
                ? aliasMatch.identification.barcodes.map(normalizeBarcodeValue).filter(Boolean)
                : [];
              let aliasRejected = false;
              if (
                normalizedProductBarcodes.length &&
                aliasMatchBarcodes.length &&
                !normalizedProductBarcodes.some((code) => aliasMatchBarcodes.includes(code))
              ) {
                aliasRejected = true;
                console.warn(
                  `Rejected alias match for ${aliasMatch.id} due to barcode mismatch (incoming ${normalizedProductBarcodes.join(
                    ', '
                  )} vs existing ${aliasMatchBarcodes.join(', ')})`
                );
                await removeProductIdentityAliases(aliasMatch.id, normalizedProductBarcodes);
              }

              if (!aliasRejected) {
                matchedExistingProduct = aliasMatch;
                matchedProductId = aliasMatch.id;
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
          }

          if (matchedExistingProduct && matchedProductId) {
            const pendingQuantity =
              (await adjustPendingIntakeQuantity(matchedProductId, 1)) ??
              ((matchedExistingProduct.ops?.pending_intake_quantity || 0) + 1);
            reuseEvents.push({
              jobId,
              productId: matchedProductId,
              pendingIntakeQuantity: pendingQuantity,
            });
            const canonicalProduct = (await getProduct(matchedProductId)) || matchedExistingProduct;
            if (aliasSet.length) {
              appendProductIdentityAliases(matchedProductId, aliasSet).catch((aliasError) => {
                console.warn(`Failed to append identity aliases for ${matchedProductId}:`, aliasError);
              });
            }
            if (
              inventoryRecord &&
              matchedExistingProduct.inventory?.inventoryId !== inventoryRecord.inventoryId
            ) {
              setProductInventory(matchedProductId, inventoryRecord).catch((inventoryError) => {
                console.warn(
                  `Failed to update product ${matchedProductId} inventory:`,
                  inventoryError.message
                );
              });
            }

            const resolvedProduct = {
              ...canonicalProduct,
              ops: {
                ...(canonicalProduct.ops || {}),
                pending_intake_quantity: pendingQuantity,
              },
            };
            bundleProducts[index] = resolvedProduct;
            continue;
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

          const dedupeKey = buildDedupeKey(product);
          if (dedupeKeys.has(dedupeKey)) {
            console.log(`Skipping duplicate product candidate (${dedupeKey}) for job ${jobId}`);
            continue;
          }
          dedupeKeys.add(dedupeKey);

          // HARD QUALITY GATE:
          // We do NOT persist identify outputs that are not "eBay-ready".
          // This prevents a workflow where empty datasheets are created and later "fixed" by Improve.
          const quality = evaluateEbayReady(product);
          if (!quality.ok) {
            const hint = JSON.stringify(quality.snapshot);
            const issues = quality.issues.join(',');
            throw new Error(
              `Identify output not ebay-ready for product ${product.id || 'n/a'} (issues=${issues}) snapshot=${hint}`
            );
          }

          await saveProductV2(product);

          // Auto-trigger Quality Gate for newly identified products.
          try {
            const jobId = require('crypto').randomUUID();
            await createQualityJob(
              {
                payload: { productId: product.id },
                productId: product.id,
                productName: product.identification?.name || '',
                locale: jobSnapshot.payload?.locale || 'de-DE',
                reason: 'auto_after_identify',
                requestedBy: 'identify-job',
                force: false,
              },
              jobId
            );
            enqueueQualityJob(jobId, true);
          } catch (qErr) {
            console.warn(`Failed to enqueue quality job for ${product.id}:`, qErr?.message || qErr);
          }

          bundleProducts[index] = product;
        } catch (saveError) {
          console.error(`Auto-Save failed for product ${product?.id || 'unknown'} in job ${jobId}:`, saveError);
          // Re-throw to ensure the job is marked as failed if a product cannot be saved
          throw saveError;
        }
      }

      result.bundle.products = bundleProducts;
      if (reuseEvents.length) {
        result.bundle.reuseEvents = reuseEvents;
      }
    }

    await updateJob(jobId, {
      status: 'done',
      finishedAt: Timestamp.now(),
      result: result.bundle,
      serpTrace: result.serpTrace,
      modelUsed: result.modelResponse?.model || result.modelUsed || null,
      reuseEvents: result.bundle?.reuseEvents || [],
    });
  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);
    const attempts = jobSnapshot.attempts || 1;
    const shouldRetry = attempts < MAX_ATTEMPTS;
    const isTimeout = error.message?.startsWith('Job timeout');

    await updateJob(jobId, {
      status: shouldRetry ? 'pending' : 'failed',
      error: {
        message: error.message,
        stack: error.stack?.slice(0, 1000),
        isTimeout,
      },
    });

    if (shouldRetry) {
      // Exponential backoff: 5s, 10s, 20s, ...
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempts - 1);
      setTimeout(() => enqueueJob(jobId, true), delay);
    } else {
      // Move permanently failed jobs to dead-letter collection
      try {
        await moveToDeadLetter(jobId);
        console.warn(`Job ${jobId} moved to dead-letter queue after ${attempts} attempts`);
      } catch (dlErr) {
        console.error(`Failed to move job ${jobId} to dead-letter:`, dlErr);
      }
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
    let resumed = 0;
    for (const job of jobs) {
      if (job.status === 'processing') {
        // Only reset processing jobs that are older than the stale threshold
        const startedAt = job.startedAt ? new Date(job.startedAt).getTime() : 0;
        const age = Date.now() - startedAt;
        if (age < STALE_JOB_THRESHOLD_MS) {
          continue; // Still within timeout window, skip
        }
        console.warn(`Stale job detected: ${job.id} (processing for ${Math.round(age / 1000)}s)`);
        await updateJob(job.id, { status: 'pending' });
      }
      enqueueJob(job.id, true);
      resumed++;
    }
    if (resumed > 0) {
      console.log(`Job runner resumed ${resumed} pending/stale jobs`);
    }
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
