/* eslint-disable no-console */
/**
 * Enqueue Quality Gate jobs for the full catalog.
 *
 * Usage:
 *   node backend/scripts/enqueue-quality-gate-all.js --limit 50
 *   node backend/scripts/enqueue-quality-gate-all.js --all
 *
 * Notes:
 * - Requires backend/services/quality-runner.js to be running (backend server starts it).
 * - This script only enqueues jobs; it does not process them inline.
 */

const { getAllProducts } = require('../lib/firestore');
const { createJob } = require('../lib/quality-jobs');
const crypto = require('crypto');

function parseArgs(argv) {
  const out = { all: false, limit: 100 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    if (a === '--limit') out.limit = parseInt(argv[i + 1], 10), (i += 1);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const products = await getAllProducts();
  const limit = args.all ? products.length : Math.max(1, Math.min(args.limit || 100, products.length));
  const selected = products.slice(0, limit);

  let enqueued = 0;
  for (const p of selected) {
    const jobId = crypto.randomUUID();
    await createJob(
      {
        payload: { productId: p.id },
        productId: p.id,
        productName: p.identification?.name || '',
        locale: p.locale || 'de-DE',
        reason: 'bulk',
        requestedBy: 'script',
        force: false,
      },
      jobId
    );
    enqueued += 1;
  }

  console.log(`[enqueue-quality-gate-all] enqueued ${enqueued} quality jobs (limit=${limit})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

