'use strict';

/**
 * Operator tool: read the REAL eBay/Kaufland quantity for listed products and
 * report drift vs our products_v2.inventory.availableQuantity.
 *
 * This is the answer to "can we actually SEE oversell?" — it compares against
 * the marketplace's real number, not just our last push. Drift rows go to the
 * `marketplace_drift` collection; oversell-direction drift (marketplace > ours)
 * raises an ops alert.
 *
 * COSTS API CALLS. eBay has tight rate limits — keep --limit modest and run
 * deliberately. NOT a cron by design.
 *
 * Usage:
 *   node backend/scripts/check-marketplace-drift.js                # default tenant, limit 20, records
 *   node backend/scripts/check-marketplace-drift.js --limit 50
 *   node backend/scripts/check-marketplace-drift.js --tenant default --dry   # inspect, do not record/alert
 */

const { getAllProductsV2ForTenant } = require('../lib/product-store');
const { checkProductDrift } = require('../lib/marketplace-drift');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

(async () => {
  const tenant = arg('--tenant', process.env.TENANT_ID || 'default');
  const limit = Math.max(1, parseInt(arg('--limit', '20'), 10) || 20);
  const dry = process.argv.includes('--dry');

  console.log(`[drift-check] tenant=${tenant} limit=${limit} record=${!dry}`);
  console.log('[drift-check] NOTE: this calls eBay/Kaufland APIs — mind rate limits.\n');

  const products = await getAllProductsV2ForTenant(tenant);
  const listed = products.filter((p) =>
    (p && p.ebay && p.ebay.itemId) ||
    (p && p.marketplace && p.marketplace.ebay && p.marketplace.ebay.itemId) ||
    (p && p.kaufland && p.kaufland.unitId)
  ).filter((p) => {
    const ls = (p && p.listingStatus) || {};
    return ls.ebay === 'active' || ls.kaufland === 'active';
  }).slice(0, limit);

  console.log(`[drift-check] ${products.length} products, ${listed.length} actively listed (capped to ${limit}).\n`);

  let drifted = 0;
  let oversell = 0;
  let errors = 0;
  for (const p of listed) {
    const sku = (p.identification && p.identification.sku) || p.id;
    const { ours, channels } = await checkProductDrift(p, { tenantId: tenant, record: !dry });
    for (const c of channels) {
      if (c.error) { errors += 1; console.log(`  ${sku} ${c.channel}: ERROR ${c.error}`); continue; }
      if (c.drift) {
        drifted += 1;
        const over = Number(c.marketplace) > ours;
        if (over) oversell += 1;
        console.log(`  ${over ? '🔴 OVERSELL' : '⚠️  drift'} ${sku} ${c.channel}: market=${c.marketplace} ours=${ours} (Δ${c.delta})`);
      }
    }
  }

  console.log(`\n[drift-check] done: checked=${listed.length} drifted=${drifted} oversell-direction=${oversell} apiErrors=${errors}`);
  if (oversell > 0) console.log('[drift-check] ⚠️  OVERSELL-direction drift found — marketplace shows MORE than we have.');
})().catch((err) => {
  console.error('[drift-check] FATAL:', err && err.message ? err.message : err);
  process.exit(1);
});
