/* eslint-disable no-console */
/**
 * Enqueue BaseLinker sync jobs for (optionally) the full catalog.
 *
 * This script ONLY enqueues jobs into Firestore collection `baselinkerSyncJobs`.
 * Processing is handled by the running backend service (it starts the BaseLinker sync runner).
 *
 * Why jobs:
 * - Cloud Run request timeouts make "sync everything in one HTTP call" unreliable.
 * - Jobs are chunked, resumable, and provide progress in Firestore.
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/enqueue-baselinker-sync-all-products.js --all
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/enqueue-baselinker-sync-all-products.js --all --chunk-size 200
 *   GOOGLE_CLOUD_PROJECT=avycloud node backend/scripts/enqueue-baselinker-sync-all-products.js --limit 500 --offset 0
 *
 * Options:
 *   --inventory-id <id>      BaseLinker inventory id (default: BASELINKER_INVENTORY_ID or 78659)
 *   --chunk-size <n>         Products per job (default: 200, max: 500)
 *   --all                    Enqueue all products (ignores --limit except offset)
 *   --limit <n>              Enqueue only first N products (after offset). Default 200.
 *   --offset <n>             Skip first N products. Default 0.
 *   --expected-count <n>     Safety guard: require selected count to match before enqueueing.
 */

const crypto = require('crypto');
const { getAllProducts } = require('../lib/firestore');
const { createJob, Timestamp } = require('../lib/baselinker-sync-jobs');

function parseArgs(argv) {
  const out = {
    all: false,
    limit: 200,
    offset: 0,
    chunkSize: 200,
    expectedCount: 0,
    inventoryId: process.env.BASELINKER_INVENTORY_ID || '78659',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    if (a === '--limit') out.limit = parseInt(argv[i + 1], 10), (i += 1);
    if (a === '--offset' || a === '--skip') out.offset = parseInt(argv[i + 1], 10), (i += 1);
    if (a === '--chunk-size') out.chunkSize = parseInt(argv[i + 1], 10), (i += 1);
    if (a === '--expected-count') out.expectedCount = parseInt(argv[i + 1], 10), (i += 1);
    if (a === '--inventory-id') out.inventoryId = String(argv[i + 1] || ''), (i += 1);
  }
  out.limit = Number.isFinite(out.limit) ? out.limit : 200;
  out.offset = Number.isFinite(out.offset) ? out.offset : 0;
  out.chunkSize = Number.isFinite(out.chunkSize) ? out.chunkSize : 200;
  out.expectedCount = Number.isFinite(out.expectedCount) ? out.expectedCount : 0;
  out.chunkSize = Math.max(10, Math.min(out.chunkSize || 200, 500));
  out.offset = Math.max(0, out.offset || 0);
  out.limit = Math.max(1, out.limit || 200);
  out.inventoryId = String(out.inventoryId || process.env.BASELINKER_INVENTORY_ID || '78659').trim();
  return out;
}

function chunkArray(arr, chunkSize) {
  const out = [];
  for (let i = 0; i < arr.length; i += chunkSize) out.push(arr.slice(i, i + chunkSize));
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const all = await getAllProducts();
  const products = Array.isArray(all) ? all.filter((p) => p?.id) : [];

  const start = Math.min(args.offset, products.length);
  const selected = args.all
    ? products.slice(start)
    : products.slice(start, Math.min(start + args.limit, products.length));

  if (args.expectedCount && selected.length !== args.expectedCount) {
    throw new Error(
      `Safety guard failed: selected=${selected.length} but --expected-count=${args.expectedCount} (total=${products.length}, offset=${args.offset})`
    );
  }

  const invId = args.inventoryId;
  const chunks = chunkArray(selected, args.chunkSize);

  console.log(
    JSON.stringify(
      {
        action: 'enqueue-baselinker-sync-all-products',
        totalProducts: products.length,
        selected: selected.length,
        offset: args.offset,
        chunkSize: args.chunkSize,
        jobs: chunks.length,
        inventoryId: invId,
      },
      null,
      2
    )
  );

  let enqueued = 0;
  for (const chunk of chunks) {
    const ids = Array.from(new Set(chunk.map((p) => String(p.id).trim()).filter(Boolean))).slice(0, 500);
    if (!ids.length) continue;
    const jobId = crypto.randomUUID();
    await createJob(
      {
        payload: { productIds: ids, inventoryId: invId },
        status: 'pending',
        stage: 'queued',
        progress: { total: ids.length, processed: 0, synced: 0, failed: 0 },
        requestedBy: 'script',
        reason: 'bulk_all',
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      },
      jobId
    );
    enqueued += 1;
    if (enqueued % 10 === 0) {
      console.log(`[enqueue-baselinker-sync-all-products] enqueued ${enqueued}/${chunks.length} jobs...`);
    }
  }

  console.log(
    `[enqueue-baselinker-sync-all-products] done: enqueued ${enqueued} jobs (products=${selected.length}, chunkSize=${args.chunkSize}, inventoryId=${invId})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

