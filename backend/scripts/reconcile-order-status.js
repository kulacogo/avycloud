#!/usr/bin/env node
'use strict';

/**
 * Order Status Reconciliation
 *
 * Fixes:
 *  1. shipped → delivered: Orders shipped >14 days ago → mark as delivered
 *  2. stale pending: Kaufland orders in 'pending' that Kaufland API shows as sent/cancelled
 *  3. legacy 'new' orders: BaseLinker relics without omsStatus → map to correct status or cancel
 *  4. Backfill: Trigger marketplace sync to import missing orders
 *
 * Usage: node backend/scripts/reconcile-order-status.js [--dry-run]
 */

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

const DRY_RUN = process.argv.includes('--dry-run');
const SHIPPED_THRESHOLD_DAYS = 14; // Orders shipped >14 days ago → delivered

async function main() {
  console.log(`\n📋 ORDER STATUS RECONCILIATION ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'}\n`);

  const snap = await db.collection('orders').get();
  const orders = snap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));
  console.log(`Total orders in DB: ${orders.length}`);

  const now = new Date();
  const shippedCutoff = new Date(now.getTime() - SHIPPED_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);

  // ─── 1. Shipped → Delivered ────────────────────────────────────
  console.log(`\n📦 Orders shipped > ${SHIPPED_THRESHOLD_DAYS} days ago → delivered`);
  const shippedOrders = orders.filter((o) => {
    const status = o.omsStatus || o.status;
    return status === 'shipped';
  });
  console.log(`  Total in 'shipped': ${shippedOrders.length}`);

  let deliveredCount = 0;
  for (let i = 0; i < shippedOrders.length; i += 400) {
    const chunk = shippedOrders.slice(i, i + 400);
    const batch = db.batch();
    let bc = 0;
    for (const o of chunk) {
      const shippedAt = o.shippedAt ? new Date(o.shippedAt) : (o.createdAt ? new Date(o.createdAt) : null);
      if (!shippedAt || shippedAt > shippedCutoff) continue; // Too recent

      if (!DRY_RUN) {
        batch.update(o.ref, {
          omsStatus: 'delivered',
          omsStatusLabel: 'Zugestellt',
          status: 'delivered',
          statusLabel: 'Zugestellt',
          deliveredAt: o.deliveredAt || new Date(shippedAt.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
          updatedAt: now.toISOString(),
        });
        bc++;
      }
      deliveredCount++;
    }
    if (bc > 0) await batch.commit();
  }
  console.log(`  Transitioned to delivered: ${deliveredCount}`);

  // ─── 2. Stale Kaufland 'pending' → reconcile via API ──────────
  console.log('\n🏪 Stale Kaufland pending orders');
  const stalePending = orders.filter((o) => {
    const status = o.omsStatus || o.status;
    return o.marketplace === 'kaufland' && status === 'pending' && o.createdAt;
  });
  console.log(`  Total Kaufland pending: ${stalePending.length}`);

  let klReconciled = 0;
  const OMS_LABELS = { pending: 'Neu', confirmed: 'Bestätigt', shipped: 'Versendet', cancelled: 'Storniert', returned: 'Retoure', delivered: 'Zugestellt' };

  if (stalePending.length > 0) {
    // Try Kaufland API first, then age-based fallback
    let fetchKauflandOrderUnits, mapKauflandStatus;
    try {
      ({ fetchKauflandOrderUnits, mapKauflandStatus } = require('../services/order-intake-kaufland'));
    } catch (e) {
      console.warn('  Could not load Kaufland intake module');
    }

    for (const o of stalePending) {
      const mpId = o.marketplaceOrderId;
      if (!mpId) continue;

      const age = o.createdAt ? (now.getTime() - new Date(o.createdAt).getTime()) / (24 * 60 * 60 * 1000) : 999;
      let newStatus = null;

      // Try API first
      if (fetchKauflandOrderUnits) {
        try {
          const units = await fetchKauflandOrderUnits({ orderId: mpId });
          const klUnitStatus = units[0]?.status || null;
          if (klUnitStatus) {
            const mapped = mapKauflandStatus(klUnitStatus);
            if (mapped !== 'pending') {
              newStatus = mapped;
              console.log(`    ${mpId}: Kaufland API says '${klUnitStatus}' → ${mapped}`);
            }
          }
        } catch (err) {
          // API might not have data for old orders — fall through to age-based
        }
      }

      // Age-based fallback: orders >60 days old and still "pending" → cancelled
      // (Kaufland auto-cancels unshipped orders after ~14 days)
      if (!newStatus && age > 60) {
        newStatus = 'cancelled';
        console.log(`    ${mpId}: age=${Math.round(age)}d, no API data → cancelled`);
      } else if (!newStatus && age > 30) {
        newStatus = 'cancelled';
        console.log(`    ${mpId}: age=${Math.round(age)}d → cancelled (Kaufland auto-cancels after ~14d)`);
      }

      if (newStatus && !DRY_RUN) {
        await o.ref.update({
          omsStatus: newStatus,
          omsStatusLabel: OMS_LABELS[newStatus] || newStatus,
          status: newStatus,
          statusLabel: OMS_LABELS[newStatus] || newStatus,
          updatedAt: now.toISOString(),
          'ops.kauflandStatusSync': { from: 'pending', to: newStatus, syncedAt: now.toISOString(), source: 'reconcile-script' },
        });
      }
      if (newStatus) klReconciled++;
    }
  }
  console.log(`  Reconciled: ${klReconciled}`);

  // ─── 3. Legacy 'new' orders (BaseLinker relics) ────────────────
  console.log('\n🗑️  Legacy orders with status=new (no omsStatus)');
  const legacyNew = orders.filter((o) => !o.omsStatus && (o.status === 'new' || o.status === 'other'));
  console.log(`  Found: ${legacyNew.length}`);

  for (const o of legacyNew) {
    const age = o.createdAt ? (now.getTime() - new Date(o.createdAt).getTime()) / (24 * 60 * 60 * 1000) : 999;
    const status = age > 30 ? 'cancelled' : 'pending'; // Old orders → cancelled, recent → pending
    console.log(`    ${o.id} mp=${o.marketplace || 'unknown'} created=${o.createdAt} → ${status} (age: ${Math.round(age)}d)`);
    if (!DRY_RUN) {
      const OMS_LABELS = { pending: 'Neu', cancelled: 'Storniert' };
      await o.ref.update({
        omsStatus: status,
        omsStatusLabel: OMS_LABELS[status],
        updatedAt: now.toISOString(),
      });
    }
  }

  // ─── 4. Backfill missing orders ────────────────────────────────
  if (!DRY_RUN) {
    console.log('\n🔄 Backfilling missing orders from marketplaces...');
    try {
      const { syncEbayOrders } = require('../services/order-intake-ebay');
      const ebay = await syncEbayOrders({ tenantId: 'default', lookbackDays: 120 });
      console.log(`  eBay: synced=${ebay.synced}, skipped=${ebay.skipped}, total=${ebay.total}`);
    } catch (err) {
      console.warn(`  eBay sync failed: ${err.message}`);
    }
    try {
      const { syncKauflandOrders } = require('../services/order-intake-kaufland');
      const kl = await syncKauflandOrders({ tenantId: 'default', lookbackDays: 120 });
      console.log(`  Kaufland: synced=${kl.synced}, skipped=${kl.skipped}, total=${kl.total}`);
    } catch (err) {
      console.warn(`  Kaufland sync failed: ${err.message}`);
    }
  }

  // ─── Summary ──────────────────────────────────────────────────
  console.log('\n✅ Summary:');
  console.log(`  shipped → delivered: ${deliveredCount}`);
  console.log(`  Kaufland pending reconciled: ${klReconciled}`);
  console.log(`  Legacy new/other cleaned: ${legacyNew.length}`);
  if (DRY_RUN) console.log('  (DRY RUN — no changes made)');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('Reconciliation failed:', e);
  process.exit(1);
});
