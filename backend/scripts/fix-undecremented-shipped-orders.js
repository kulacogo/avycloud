/* eslint-disable no-console */
/**
 * Fix shipped orders that never had their stock decremented.
 *
 * After the fix in order-state-machine.js (idempotent processShippedOrder with
 * stockDecrementedAt guard), this script finds all orders with omsStatus='shipped'
 * that are missing the stockDecrementedAt flag and runs processShippedOrder() on them.
 *
 * Safety:
 * - Dry-run by default (only reports, no changes)
 * - processShippedOrder() is idempotent (stockDecrementedAt prevents double decrement)
 * - Stock cannot go below 0 (Math.max(0, ...) in decrementProductByIdOrSku)
 * - Filters by tenantId to avoid cross-tenant contamination
 *
 * Usage:
 *   node backend/scripts/fix-undecremented-shipped-orders.js                      # dry-run, tenant=default
 *   node backend/scripts/fix-undecremented-shipped-orders.js --tenant=trendocean  # dry-run, specific tenant
 *   node backend/scripts/fix-undecremented-shipped-orders.js --apply              # execute, tenant=default
 */

const fs = require('fs');
const path = require('path');
const { firestore } = require('../lib/firestore');
const { processShippedOrder } = require('../services/order-state-machine');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const TENANT_ID = (argv.find((a) => a.startsWith('--tenant=')) || '--tenant=default').split('=')[1];

const ORDERS_COLLECTION = 'orders';

async function main() {
  console.log(`\n=== Fix Undecremented Shipped Orders (${APPLY ? 'APPLY MODE' : 'DRY-RUN'}, tenant=${TENANT_ID}) ===\n`);

  // 1. Find shipped orders without stockDecrementedAt (scoped to tenant)
  const snap = await firestore.collection(ORDERS_COLLECTION)
    .where('tenantId', '==', TENANT_ID)
    .where('omsStatus', '==', 'shipped')
    .get();

  console.log(`Found ${snap.size} orders with omsStatus='shipped'`);

  const candidates = [];
  const alreadyDecremented = [];

  snap.forEach((doc) => {
    const data = doc.data() || {};
    if (data.stockDecrementedAt) {
      alreadyDecremented.push(doc.id);
    } else {
      const items = data.items || [];
      const skus = items.map((i) => i.sku).filter(Boolean);
      candidates.push({
        docId: doc.id,
        orderId: data.orderId || doc.id,
        marketplace: data.marketplace || data.source || '?',
        shippedAt: data.shippedAt || '?',
        skus,
        itemCount: items.length,
      });
    }
  });

  console.log(`Already decremented: ${alreadyDecremented.length}`);
  console.log(`Missing stockDecrementedAt: ${candidates.length}`);

  if (candidates.length === 0) {
    console.log('\n✓ No orders need fixing.');
    return;
  }

  console.log('\n--- Orders to fix ---');
  candidates.forEach((c) => {
    console.log(`  ${c.docId} | Order: ${c.orderId} | ${c.marketplace} | Shipped: ${c.shippedAt} | SKUs: ${c.skus.join(', ') || 'none'}`);
  });

  const report = {
    timestamp: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    tenantId: TENANT_ID,
    totalShipped: snap.size,
    alreadyDecremented: alreadyDecremented.length,
    candidates: candidates.length,
    fixed: 0,
    errors: 0,
    skipped: 0,
    details: [],
  };

  if (APPLY) {
    console.log(`\nProcessing ${candidates.length} orders...`);

    for (const c of candidates) {
      if (c.skus.length === 0) {
        console.log(`  SKIP ${c.docId} — no SKUs in items`);
        report.skipped++;
        report.details.push({ docId: c.docId, status: 'skipped', reason: 'no SKUs' });
        continue;
      }

      try {
        await processShippedOrder({ orderId: c.docId, tenantId: TENANT_ID });
        console.log(`  ✓ ${c.docId} — processShippedOrder completed`);
        report.fixed++;
        report.details.push({ docId: c.docId, status: 'fixed', skus: c.skus });
      } catch (err) {
        console.error(`  ✗ ${c.docId} — ${err.message}`);
        report.errors++;
        report.details.push({ docId: c.docId, status: 'error', error: err.message });
      }
    }

    console.log(`\n✓ Fixed: ${report.fixed}, Errors: ${report.errors}, Skipped: ${report.skipped}`);
  } else {
    console.log(`\n→ ${candidates.length} orders would be fixed. Use --apply to execute.`);
  }

  // Write report
  const outDir = path.join(process.cwd(), 'exports', 'reconciliation');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'fix-undecremented-shipped-orders.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nReport: ${outPath}`);
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
