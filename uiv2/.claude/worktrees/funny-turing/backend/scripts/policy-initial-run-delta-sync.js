/* eslint-disable no-console */
/**
 * Policy Initial Run + BaseLinker Delta Sync
 *
 * Requirement:
 * - After each rule change, we MUST:
 *   1) run an initial pass over all affected products
 *   2) sync ONLY the datasheet updates (text_fields) to BaseLinker (no full sync)
 *
 * This script:
 * - loads all products
 * - applies the strict rulebook normalization (title + highlights + canonical attributes)
 * - saves only changed products
 * - enqueues BaseLinker sync jobs in "text_only" mode for the changed products
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/policy-initial-run-delta-sync.js --dry-run
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/policy-initial-run-delta-sync.js --apply --expected-count 631
 *
 * Options:
 *   --inventory-id <id>      BaseLinker inventory id (default: BASELINKER_INVENTORY_ID or 78659)
 *   --chunk-size <n>         Products per BaseLinker job (default 200, max 500)
 *   --limit <n>              Limit products processed (for testing)
 */

const crypto = require('crypto');
const { getAllProducts, getProduct, saveProduct } = require('../lib/firestore');
const { createJob, Timestamp } = require('../lib/baselinker-sync-jobs');
const { normalizeProductStrict } = require('../lib/llm-rulebook');

function argFlag(name) {
  return process.argv.includes(name);
}
function argValue(name, fallback = null) {
  const idx = process.argv.findIndex((x) => x === name);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function deepEqualJson(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function chunkArray(arr, chunkSize) {
  const out = [];
  for (let i = 0; i < arr.length; i += chunkSize) out.push(arr.slice(i, i + chunkSize));
  return out;
}

async function main() {
  const apply = argFlag('--apply');
  const dryRun = !apply;
  const expectedCount = Number(argValue('--expected-count', '0') || 0);
  const limit = Number(argValue('--limit', '0') || 0);
  const invId = String(argValue('--inventory-id', process.env.BASELINKER_INVENTORY_ID || '78659')).trim();
  const chunkSize = Math.max(10, Math.min(500, Number(argValue('--chunk-size', '200') || 200)));

  const all = await getAllProducts();
  const products = Array.isArray(all) ? all.filter((p) => p?.id) : [];
  const total = products.length;

  if (apply) {
    if (!expectedCount || expectedCount <= 0) {
      throw new Error('ABORT: --apply requires --expected-count <number>');
    }
    if (expectedCount !== total) {
      throw new Error(`ABORT: expectedCount=${expectedCount} but got total=${total}`);
    }
  }

  const selected = limit && limit > 0 ? products.slice(0, limit) : products;
  console.log(JSON.stringify({ action: 'policy-initial-run-delta-sync', dryRun, total, selected: selected.length, invId, chunkSize }, null, 2));

  let changed = 0;
  let unchanged = 0;
  let invalid = 0;
  const changedIds = [];
  const invalidIds = [];

  for (const p of selected) {
    const fresh = await getProduct(String(p.id)).catch(() => null);
    const current = fresh || p;
    const strict = normalizeProductStrict(current, { source: 'policy-initial-run' });
    if (!strict.ok) {
      invalid += 1;
      invalidIds.push({ id: current.id, issues: strict.issues });
      continue;
    }
    const next = strict.product;

    // Only compare fields we normalize here (title + highlights + attributes + short_description cleanup).
    const beforeSnap = {
      identification: { name: current?.identification?.name || '' },
      details: {
        key_features: Array.isArray(current?.details?.key_features) ? current.details.key_features : [],
        attributes:
          current?.details?.attributes && typeof current.details.attributes === 'object' && !Array.isArray(current.details.attributes)
            ? current.details.attributes
            : {},
        short_description: current?.details?.short_description || '',
      },
    };
    const afterSnap = {
      identification: { name: next?.identification?.name || '' },
      details: {
        key_features: Array.isArray(next?.details?.key_features) ? next.details.key_features : [],
        attributes:
          next?.details?.attributes && typeof next.details.attributes === 'object' && !Array.isArray(next.details.attributes)
            ? next.details.attributes
            : {},
        short_description: next?.details?.short_description || '',
      },
    };
    const isSame = deepEqualJson(beforeSnap, afterSnap);
    if (isSame) {
      unchanged += 1;
      continue;
    }

    changed += 1;
    changedIds.push(String(current.id));

    if (!dryRun) {
      await saveProduct(next, { source: 'policy-initial-run', overwriteTextFields: true });
    }
  }

  console.log(JSON.stringify({ done: true, total: selected.length, changed, unchanged, invalid }, null, 2));

  if (dryRun) {
    console.log('[policy-initial-run-delta-sync] DRY RUN: not saving, not enqueueing BaseLinker jobs.');
    return;
  }

  // Enqueue BaseLinker delta sync jobs for changed products only.
  const chunks = chunkArray(changedIds, chunkSize);
  let enqueued = 0;
  for (const ids of chunks) {
    if (!ids.length) continue;
    const jobId = crypto.randomUUID();
    await createJob(
      {
        payload: { productIds: ids, inventoryId: invId, mode: 'text_only' },
        status: 'pending',
        stage: 'queued',
        progress: { total: ids.length, processed: 0, synced: 0, failed: 0 },
        requestedBy: 'script',
        reason: 'policy_delta_sync',
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      },
      jobId
    );
    enqueued += 1;
  }

  console.log(
    JSON.stringify(
      { baselinker_jobs_enqueued: enqueued, products_enqueued: changedIds.length, inventoryId: invId, mode: 'text_only' },
      null,
      2
    )
  );

  if (invalidIds.length) {
    console.log(
      JSON.stringify(
        {
          invalid_count: invalidIds.length,
          invalid_preview: invalidIds.slice(0, 20),
        },
        null,
        2
      )
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

