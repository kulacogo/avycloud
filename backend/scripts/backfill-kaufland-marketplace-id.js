#!/usr/bin/env node
'use strict';
/**
 * Backfill marketplaceOrderId + marketplaceKey for old BaseLinker Kaufland orders.
 *
 * Old BL Kaufland orders have:
 *   - baselinkerId set, no marketplaceKey, no proper marketplaceOrderId
 *   - BUT: raw.external_order_id = actual Kaufland order ID (e.g. 'MFADA35')
 *
 * After backfill, the standard dedup in saveOrderIfNew() will prevent duplicates
 * when the native Kaufland sync runs.
 *
 * Usage:
 *   GCLOUD_PROJECT=avycloud node backend/scripts/backfill-kaufland-marketplace-id.js --dry-run
 *   GCLOUD_PROJECT=avycloud node backend/scripts/backfill-kaufland-marketplace-id.js --write
 */
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

const DRY_RUN = !process.argv.includes('--write');

async function main() {
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'WRITE'}\n`);

  // Fetch all orders (paginate to get all)
  const snap = await db.collection('orders').orderBy('createdAt', 'asc').get();
  console.log(`Total orders: ${snap.size}`);

  const toUpdate = [];

  for (const doc of snap.docs) {
    const d = doc.data();

    // Target: Kaufland BL orders without marketplaceKey
    if (d.marketplace !== 'kaufland') continue;
    if (!d.baselinkerId) continue;
    if (d.marketplaceKey) continue; // already has it

    const klOrderId = d.raw?.external_order_id;
    if (!klOrderId || klOrderId === '-' || klOrderId.length < 5) continue;

    const marketplaceKey = `kaufland__${klOrderId}`;
    toUpdate.push({
      id: doc.id,
      ref: doc.ref,
      klOrderId,
      marketplaceKey,
      currentMpId: d.marketplaceOrderId,
    });
  }

  console.log(`\nOld BL Kaufland docs to backfill: ${toUpdate.length}`);

  for (const u of toUpdate) {
    console.log(`  ${u.id}: marketplaceOrderId=${u.klOrderId} marketplaceKey=${u.marketplaceKey} (was: ${u.currentMpId})`);
  }

  if (DRY_RUN) {
    console.log('\nDRY RUN — no changes made. Run with --write to apply.');
    return;
  }

  // Update in batches of 400
  let updated = 0;
  for (let i = 0; i < toUpdate.length; i += 400) {
    const batch = db.batch();
    toUpdate.slice(i, i + 400).forEach(({ ref, klOrderId, marketplaceKey }) => {
      batch.update(ref, {
        marketplaceOrderId: klOrderId,
        externalOrderId: klOrderId,
        marketplaceKey,
        updatedAt: new Date().toISOString(),
      });
    });
    await batch.commit();
    updated += Math.min(400, toUpdate.length - i);
    console.log(`Updated ${updated}/${toUpdate.length}...`);
  }
  console.log(`\nDone. Backfilled ${updated} Kaufland orders with proper marketplaceOrderId + marketplaceKey.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
