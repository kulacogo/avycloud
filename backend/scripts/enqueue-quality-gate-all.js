/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Add --tenant flag for multi-tenant runs.
 */
/**
 * Enqueue Quality Gate jobs for the full catalog.
 *
 * Usage:
 *   node backend/scripts/enqueue-quality-gate-all.js --limit 50
 *   node backend/scripts/enqueue-quality-gate-all.js --all
 *   node backend/scripts/enqueue-quality-gate-all.js --all --force
 *
 * Notes:
 * - Requires backend/services/quality-runner.js to be running (backend server starts it).
 * - This script only enqueues jobs; it does not process them inline.
 */

const { getAllProducts, getAllProductsForTenant } = require('../lib/firestore');

// D.0b-Hardening 2026-05-11: mandatory TENANT_ID for write scripts (prevents silent cross-tenant writes)
const TENANT_ID = process.env.TENANT_ID;
if (!TENANT_ID) {
  console.error('TENANT_ID env var required. Example: TENANT_ID=avycloud node <script>.js');
  process.exit(1);
}
console.warn(`[D.0b-Hardening] Running for tenantId='${TENANT_ID}'.`);
const { createJob } = require('../lib/quality-jobs');
const crypto = require('crypto');

function parseArgs(argv) {
  const out = { all: false, limit: 100, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    if (a === '--force') out.force = true;
    if (a === '--limit') out.limit = parseInt(argv[i + 1], 10), (i += 1);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const products = await getAllProductsForTenant(TENANT_ID);
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
        force: Boolean(args.force),
      },
      jobId
    );
    enqueued += 1;
  }

  console.log(`[enqueue-quality-gate-all] enqueued ${enqueued} quality jobs (limit=${limit}, force=${Boolean(args.force)})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

