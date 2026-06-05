/**
 * Bulk Update Service — update specific fields across multiple products.
 *
 * Core design decisions:
 * - ALL writes go through saveProductV2({ mode: 'manual' }) — no shortcuts
 * - dryRun mode returns a diff without writing
 * - Parallel execution via p-limit (concurrency 5) for performance
 * - Max 500 products per call
 */

const { getProductV2, saveProductV2 } = require('../lib/product-store');

const MAX_PRODUCTS_PER_BATCH = 500;
const CONCURRENCY = 5;

// Allowed field paths that users can bulk-update.
// NOTE: inventory.quantity is intentionally NOT here — stock mutations must go through
// withStockLock() + the warehouse flow (CLAUDE.md #10/#12/#13, oversell / single-writer
// invariant), never this generic path.
const ALLOWED_FIELDS = new Set([
  'identification.name',
  'identification.brand',
  'identification.category',
  'details.identifiers.mpn',
  'details.weight',
  'details.pricing.sellPrice',
  'details.pricing.buyPrice',
  'details.pricing.lowest_price.amount',
  'details.attributes.condition',
  'ops.sync_status',
  'ops.readiness',
]);

/**
 * Get a nested value from an object by dot-delimited path.
 */
function getNestedValue(obj, path) {
  const keys = path.split('.');
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Set a nested value on an object by dot-delimited path.
 * Creates intermediate objects as needed.
 */
function setNestedValue(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] == null || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
}

/**
 * Deep-clone a plain object (JSON-safe).
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Bulk update products.
 *
 * @param {Object} params
 * @param {string[]} params.productIds - Product IDs to update (max 500)
 * @param {{ field: string, value: any }[]} params.updates - Fields to update
 * @param {boolean} [params.dryRun=false] - If true, returns diff without writing
 * @param {string} [params.tenantId='default'] - Tenant ID for multi-tenancy
 * @returns {Promise<{ updated: number, skipped: number, errors: Array, diff?: Array, duration_ms: number }>}
 */
async function bulkUpdateProducts({ productIds, updates, dryRun = false, tenantId = 'default' }) {
  const startTime = Date.now();

  // Validation
  if (!Array.isArray(productIds) || productIds.length === 0) {
    throw Object.assign(new Error('productIds must contain 1-500 items'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }
  if (productIds.length > MAX_PRODUCTS_PER_BATCH) {
    throw Object.assign(new Error(`productIds must contain 1-${MAX_PRODUCTS_PER_BATCH} items`), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }
  if (!Array.isArray(updates) || updates.length === 0) {
    throw Object.assign(new Error('updates must contain at least one field update'), { statusCode: 400, code: 'VALIDATION_ERROR' });
  }

  // Validate field paths
  for (const update of updates) {
    if (!update.field || typeof update.field !== 'string') {
      throw Object.assign(new Error('Each update must have a field path'), { statusCode: 400, code: 'VALIDATION_ERROR' });
    }
    if (!ALLOWED_FIELDS.has(update.field)) {
      throw Object.assign(new Error(`Unbekanntes Feld: ${update.field}`), { statusCode: 400, code: 'VALIDATION_ERROR' });
    }
  }

  // Deduplicate product IDs
  const uniqueIds = [...new Set(productIds)];

  const results = {
    updated: 0,
    skipped: 0,
    errors: [],
    diff: dryRun ? [] : undefined,
    duration_ms: 0,
  };

  // Process with concurrency control
  const pLimit = (await import('p-limit')).default;
  const limit = pLimit(CONCURRENCY);

  const tasks = uniqueIds.map((productId) =>
    limit(async () => {
      try {
        const product = await getProductV2(productId);
        if (!product) {
          results.errors.push({ id: productId, reason: 'Product not found' });
          return;
        }

        // Check for actual changes
        const changes = [];
        const merged = deepClone(product);

        for (const { field, value } of updates) {
          const oldValue = getNestedValue(product, field);
          // Normalize comparison: treat null/undefined/'' as equivalent for skip detection
          const oldNorm = oldValue ?? '';
          const newNorm = value ?? '';
          if (String(oldNorm) === String(newNorm)) continue;

          changes.push({
            field,
            oldValue: oldValue ?? null,
            newValue: value,
          });
          setNestedValue(merged, field, value);
        }

        if (changes.length === 0) {
          results.skipped++;
          if (dryRun) {
            results.diff.push({
              productId,
              productName: product.identification?.name || product.id,
              changes: [],
              status: 'skipped',
              reason: 'No change',
            });
          }
          return;
        }

        if (dryRun) {
          results.diff.push({
            productId,
            productName: product.identification?.name || product.id,
            changes,
            status: 'ready',
          });
          // dryRun counts as "would update"
          results.updated++;
          return;
        }

        // Actual write — always through saveProductV2 with mode: 'manual'
        await saveProductV2(merged, { mode: 'manual' });
        results.updated++;
      } catch (err) {
        results.errors.push({
          id: productId,
          reason: err.message || 'Unknown error',
        });
      }
    })
  );

  await Promise.all(tasks);
  results.duration_ms = Date.now() - startTime;
  return results;
}

module.exports = {
  bulkUpdateProducts,
  ALLOWED_FIELDS,
  MAX_PRODUCTS_PER_BATCH,
  getNestedValue,
  setNestedValue,
};
