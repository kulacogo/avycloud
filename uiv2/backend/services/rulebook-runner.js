const PQueue = require('p-queue').default || require('p-queue');
const crypto = require('crypto');
const {
  claimJob,
  updateJob,
  listJobsByStatus,
  Timestamp,
} = require('../lib/rulebook-apply-jobs');
const { getProduct, getAllProducts, saveProduct } = require('../lib/firestore');
const { normalizeProductForPolicyApply } = require('../lib/llm-rulebook');
const { getProductBinSummaryMap } = require('../lib/warehouse');
const { createJob: createBaseLinkerSyncJob, Timestamp: BaseLinkerSyncTimestamp } = require('../lib/baselinker-sync-jobs');
const { enqueueBaseLinkerSyncJob } = require('./baselinker-sync-runner');

const CONCURRENCY = parseInt(process.env.RULEBOOK_JOB_CONCURRENCY || '1', 10);
const MAX_ATTEMPTS = parseInt(process.env.RULEBOOK_JOB_MAX_ATTEMPTS || '2', 10);
const JOB_SWEEP_INTERVAL_MS = parseInt(process.env.RULEBOOK_JOB_SWEEP_MS || '45000', 10);
const JOB_RETRY_BACKOFF_MS = parseInt(process.env.RULEBOOK_JOB_BACKOFF_MS || '30000', 10);

const queue = new PQueue({ concurrency: CONCURRENCY });
let sweepTimer = null;
let sweepInFlight = false;

function chunkArray(arr, chunkSize) {
  const out = [];
  for (let i = 0; i < arr.length; i += chunkSize) out.push(arr.slice(i, i + chunkSize));
  return out;
}

async function enqueueBaseLinkerTextOnlyJobs({ productIds, inventoryId, chunkSize = 200 }) {
  const invId = String(inventoryId || process.env.BASELINKER_INVENTORY_ID || '78659').trim();
  const chunks = chunkArray(productIds, Math.max(10, Math.min(500, chunkSize)));
  const jobIds = [];
  for (const ids of chunks) {
    const unique = Array.from(new Set(ids.map((x) => String(x).trim()).filter(Boolean))).slice(0, 500);
    if (!unique.length) continue;
    const job = await createBaseLinkerSyncJob({
      payload: { productIds: unique, inventoryId: invId, mode: 'text_only' },
      status: 'pending',
      stage: 'queued',
      progress: { total: unique.length, processed: 0, synced: 0, failed: 0 },
      requestedBy: 'rulebook-runner',
      createdAt: BaseLinkerSyncTimestamp.now(),
      updatedAt: BaseLinkerSyncTimestamp.now(),
    });
    enqueueBaseLinkerSyncJob(job.id, true);
    jobIds.push(job.id);
  }
  return jobIds;
}

async function processRulebookJob(jobId) {
  let jobSnapshot;
  try {
    jobSnapshot = await claimJob(jobId);
  } catch (error) {
    if (error.message === 'Job not pending' || error.message === 'Job not found') return;
    console.error(`Failed to claim rulebook job ${jobId}:`, error);
    return;
  }

  try {
    const invId = String(jobSnapshot?.payload?.inventoryId || process.env.BASELINKER_INVENTORY_ID || '78659').trim();
    const limit = Number(jobSnapshot?.payload?.limit || 0);
    const chunkSize = Number(jobSnapshot?.payload?.chunkSize || 200);
    const minQtyRaw = jobSnapshot?.payload?.minQty;
    const minQty = typeof minQtyRaw === 'number' && Number.isFinite(minQtyRaw) ? Math.max(1, Math.min(9999, minQtyRaw)) : null;
    const requireBin =
      typeof jobSnapshot?.payload?.requireBin === 'boolean' ? jobSnapshot.payload.requireBin : null;

    // Match /api/products semantics for BIN + quantity (enrich via warehouse bin summaries)
    const safeString = (v) => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
    const normalizeIdentityKey = (value) => {
      if (value === undefined || value === null) return null;
      const normalized = String(value).trim();
      if (!normalized) return null;
      return normalized.toLowerCase();
    };
    const buildSkuToProductIdMap = (products = []) => {
      const map = new Map();
      products.forEach((product) => {
        if (!product || !product.id) return;
        const productId = String(product.id);
        const addKey = (value) => {
          const key = normalizeIdentityKey(value);
          if (key) {
            map.set(key, productId);
            const trimmed = key.replace(/^sku[-_\\s]*/, '');
            if (trimmed && !map.has(trimmed)) {
              map.set(trimmed, productId);
            }
          }
        };
        addKey(productId);
        addKey(product.identification?.sku);
        addKey(product.details?.identifiers?.sku);
        addKey(product.details?.identifiers?.ean);
        addKey(product.details?.identifiers?.gtin);
        addKey(product.details?.identifiers?.upc);
      });
      return map;
    };
    const enrichProductsWithBinSummaries = async (products = []) => {
      if (!Array.isArray(products) || products.length === 0) return products;
      const productIds = products
        .map((product) => (product?.id ? String(product.id) : null))
        .filter(Boolean);
      if (!productIds.length) return products;
      const skuMap = buildSkuToProductIdMap(products);
      const summaryMap = await getProductBinSummaryMap(productIds, skuMap);
      return products.map((product) => {
        const key = product?.id ? String(product.id) : null;
        if (!key || !summaryMap.has(key)) {
          return product;
        }
        const summary = summaryMap.get(key);
        const mergedInventory = {
          ...(product.inventory || {}),
          quantity: summary.totalQuantity,
          physicalQuantity: summary.totalQuantity,
        };
        return {
          ...product,
          inventory: mergedInventory,
          storageBins: summary.bins,
        };
      });
    };
    // Ghost/stub filter (same intent as backend/index.js)
    const isGhostProduct = (product = {}) => {
      const identification = product?.identification || {};
      const details = product?.details || {};
      const sku = safeString(details?.identifiers?.sku) || safeString(identification?.sku) || '';
      const name = safeString(identification?.name) || safeString(details?.title) || '';
      if (!safeString(product?.id) && !sku) return true;
      if (!sku && !name) return true;
      const hasAnyDetailsKey = details && typeof details === 'object' && Object.keys(details).length > 0;
      const hasAnyIdentificationKey =
        identification && typeof identification === 'object' && Object.keys(identification).length > 0;
      if (!hasAnyDetailsKey && !hasAnyIdentificationKey) return true;
      return false;
    };
    const hasBin = (p) =>
      Boolean(p?.storage?.binCode) || (Array.isArray(p?.storageBins) && p.storageBins.length > 0);
    const pickQty = (p) => {
      const physical = p?.inventory?.physicalQuantity;
      if (typeof physical === 'number' && Number.isFinite(physical) && physical >= 0) return physical;
      const inv = p?.inventory?.quantity;
      if (typeof inv === 'number' && Number.isFinite(inv) && inv >= 0) return inv;
      const bins = Array.isArray(p?.storageBins) ? p.storageBins : [];
      return bins.reduce((s, b) => s + (Number(b?.quantity) || 0), 0);
    };

    const all = await getAllProducts();
    const productsRaw = Array.isArray(all) ? all.filter((p) => p?.id && !isGhostProduct(p)) : [];
    const products = await enrichProductsWithBinSummaries(productsRaw);
    const filtered = products
      .filter((p) => (requireBin == null ? true : requireBin ? hasBin(p) : true))
      .filter((p) => (minQty == null ? true : pickQty(p) >= minQty));
    const selected = limit && limit > 0 ? filtered.slice(0, limit) : filtered;

    await updateJob(jobId, {
      stage: 'processing',
      progress: { total: selected.length, processed: 0, changed: 0, invalid: 0, enqueued: 0 },
      updatedAt: Timestamp.now(),
    });

    let processed = 0;
    let changed = 0;
    let invalid = 0;
    const changedIds = [];
    const invalidPreview = [];

    const flushEvery = 20;
    for (const p of selected) {
      processed += 1;
      const fresh = await getProduct(String(p.id)).catch(() => null);
      const current = fresh || p;
      const normalized = normalizeProductForPolicyApply(current, { source: 'rulebook-runner' });
      const next = normalized.product;

      // Track issues (non-blocking) so you can see why some products are still non-compliant.
      if (Array.isArray(normalized.issues) && normalized.issues.length) {
        invalid += 1;
        if (invalidPreview.length < 25) invalidPreview.push({ id: current.id, issues: normalized.issues });
      }

      // Compare only fields we enforce here
      const before = JSON.stringify({
        t: current?.identification?.name || '',
        h: Array.isArray(current?.details?.key_features) ? current.details.key_features : [],
        a:
          current?.details?.attributes && typeof current.details.attributes === 'object' && !Array.isArray(current.details.attributes)
            ? current.details.attributes
            : {},
        d: current?.details?.short_description || '',
      });
      const after = JSON.stringify({
        t: next?.identification?.name || '',
        h: Array.isArray(next?.details?.key_features) ? next.details.key_features : [],
        a:
          next?.details?.attributes && typeof next.details.attributes === 'object' && !Array.isArray(next.details.attributes)
            ? next.details.attributes
            : {},
        d: next?.details?.short_description || '',
      });
      if (before !== after) {
        changed += 1;
        changedIds.push(String(current.id));
        await saveProduct(next, { source: 'rulebook-apply', overwriteTextFields: true });
      }

      if (processed % flushEvery === 0 || processed === selected.length) {
        await updateJob(jobId, {
          stage: 'processing',
          progress: { total: selected.length, processed, changed, invalid, enqueued: 0 },
        });
      }
    }

    await updateJob(jobId, {
      stage: 'enqueue_baselinker',
      progress: { total: selected.length, processed, changed, invalid, enqueued: 0 },
    });

    const blJobIds = await enqueueBaseLinkerTextOnlyJobs({
      productIds: changedIds,
      inventoryId: invId,
      chunkSize,
    });

    await updateJob(jobId, {
      status: 'done',
      stage: 'complete',
      finishedAt: Timestamp.now(),
      progress: { total: selected.length, processed, changed, invalid, enqueued: changedIds.length },
      result: {
        inventoryId: invId,
        changedProductIdsCount: changedIds.length,
        baselinkerJobIds: blJobIds,
        invalidPreview,
      },
      error: null,
    });
  } catch (error) {
    console.error(`Rulebook apply job ${jobId} failed:`, error);
    const attempts = jobSnapshot.attempts || 1;
    const shouldRetry = attempts < MAX_ATTEMPTS;
    await updateJob(jobId, {
      status: shouldRetry ? 'pending' : 'failed',
      stage: shouldRetry ? 'queued' : 'failed',
      error: { message: error.message, stack: error.stack?.slice(0, 1200) },
      finishedAt: shouldRetry ? null : Timestamp.now(),
    });
    if (shouldRetry) {
      const backoff = JOB_RETRY_BACKOFF_MS * (attempts || 1);
      setTimeout(() => enqueueRulebookJob(jobId, true), backoff);
    }
  }
}

function enqueueRulebookJob(jobId, silent = false) {
  queue.add(() =>
    processRulebookJob(jobId).catch((error) => {
      if (!silent) console.error(`Unexpected error in rulebook queue for job ${jobId}:`, error);
    })
  );
}

async function resumePendingRulebookJobs() {
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    const jobs = await listJobsByStatus(['pending', 'processing']);
    if (!jobs.length) return;
    for (const job of jobs) {
      if (job.status === 'processing') {
        await updateJob(job.id, { status: 'pending', startedAt: null, stage: 'queued' });
      }
      enqueueRulebookJob(job.id, true);
    }
    console.log(`Rulebook runner resumed ${jobs.length} pending jobs`);
  } catch (error) {
    console.error('Failed to resume pending rulebook jobs:', error);
  } finally {
    sweepInFlight = false;
  }
}

function startRulebookRunner() {
  resumePendingRulebookJobs().catch((error) => console.error('Initial rulebook resume failed:', error));
  if (sweepTimer || JOB_SWEEP_INTERVAL_MS <= 0) return;
  sweepTimer = setInterval(() => {
    resumePendingRulebookJobs().catch((error) => console.error('Scheduled rulebook resume failed:', error));
  }, JOB_SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

module.exports = {
  enqueueRulebookJob,
  startRulebookRunner,
};

