/* eslint-disable no-console */
/**
 * D.0b-Migration 2026-05-10: Migrated to getAllProductsForTenant().
 * See /Users/oguz/.claude/plans/sieht-ziemlich-komplex-unstrukturiert-woolly-tulip.md (Phase D.0)
 * D.0b-Migration: Default to avycloud. Add --tenant flag for multi-tenant runs.
 */
/**
 * Backfill normalization across ALL products without changing titles/descriptions.
 *
 * Purpose:
 * - Enforce deterministic attribute consolidation (enforceEbayAspects) for existing docs.
 * - Optionally apply enabled category profiles (attribute alias normalization) via saveProduct().
 * - Keep AvyCloud "source of truth" stable: DO NOT auto-generate / overwrite titles in this backfill.
 *
 * Safety:
 * - Default mode is DRY RUN.
 * - Never writes warehouse fields (storage/storageBins/inventory) during this pass.
 *
 * Usage:
 *   node backend/scripts/backfill-normalize-products.js --dry-run --limit 200
 *   node backend/scripts/backfill-normalize-products.js --apply --expected-count 604
 */

const { getAllProducts, getAllProductsForTenant, saveProduct } = require('../lib/firestore');


// D.0b-Hardening 2026-05-11: mandatory TENANT_ID for write scripts (prevents silent cross-tenant writes)
const TENANT_ID = process.env.TENANT_ID;
if (!TENANT_ID) {
  console.error('TENANT_ID env var required. Example: TENANT_ID=avycloud node <script>.js');
  process.exit(1);
}
console.warn(`[D.0b-Hardening] Running for tenantId='${TENANT_ID}'.`);
function parseArgs(argv) {
  const args = { dryRun: true, limit: null, expectedCount: null };
  for (let i = 2; i < argv.length; i += 1) {
    const t = argv[i];
    if (t === '--apply') args.dryRun = false;
    else if (t === '--dry-run') args.dryRun = true;
    else if (t === '--limit') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) args.limit = Math.floor(n);
      i += 1;
    } else if (t === '--expected-count') {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) args.expectedCount = Math.floor(n);
      i += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const products = await getAllProductsForTenant(TENANT_ID);
  const list = args.limit ? products.slice(0, args.limit) : products;

  if (args.expectedCount != null && list.length !== args.expectedCount) {
    throw new Error(
      `Guard failed: expected ${args.expectedCount} products but loaded ${list.length}. Refusing to continue.`
    );
  }

  const report = { loaded: list.length, dryRun: args.dryRun, updated: 0, failed: 0 };
  for (const p of list) {
    try {
      if (!p?.id) continue;
      if (!args.dryRun) {
        await saveProduct(p, {
          source: 'script:backfill-normalize-products',
          // Don't touch user-facing text in this hygiene pass.
          overwriteTextFields: false,
          replaceAttributes: false,
          allowCategoryChange: false,
          allowWarehouseFields: false,
          // Critical: do NOT rewrite title policy automatically here.
          skipTitlePolicy: true,
          // Keep highlights stable too (optional).
          skipKeyFeaturesNormalize: true,
        });
        report.updated += 1;
      }
    } catch (e) {
      report.failed += 1;
      if (report.failed <= 20) {
        console.warn('[backfill-normalize-products] failed:', p?.id, e?.message || e);
      }
    }
  }

  console.log('[backfill-normalize-products] done', JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

