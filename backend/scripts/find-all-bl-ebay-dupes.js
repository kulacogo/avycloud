'use strict';
/**
 * Find ALL BL legacy docs whose `number` field matches the `marketplaceOrderId` of an OMS doc.
 * These are the problematic duplicates.
 */
const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore();

async function main() {
  const snap = await db.collection('orders').get();
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  // OMS docs: have marketplaceOrderId + marketplaceKey
  const omsIds = new Set(all.filter(o => o.marketplaceOrderId).map(o => o.marketplaceOrderId));

  // BL legacy docs: have baselinkerId, no marketplaceKey
  const blDocs = all.filter(o => o.baselinkerId && !o.marketplaceKey);

  // BL docs whose `number` matches an OMS marketplaceOrderId
  const dupes = blDocs.filter(o => omsIds.has(o.number));

  // Also BL docs whose `raw.external_order_id` matches
  const dupesViaExternal = blDocs.filter(o => !omsIds.has(o.number) && o.raw && omsIds.has(o.raw.external_order_id));

  console.log('Total orders:', all.length);
  console.log('OMS docs:', all.filter(o => o.marketplaceOrderId).length);
  console.log('BL legacy docs total:', blDocs.length);
  console.log('BL dupes (number matches OMS marketplaceOrderId):', dupes.length);
  console.log('BL dupes (via raw.external_order_id):', dupesViaExternal.length);

  const allDupes = [...dupes, ...dupesViaExternal];
  if (allDupes.length > 0) {
    console.log('\nDuplicate BL docs to delete:');
    allDupes.forEach(o => {
      console.log(`  ${o.id} → number="${o.number}" / external="${o.raw?.external_order_id}" | status="${o.statusLabel || o.status}"`);
    });

    if (process.argv[2] === '--delete') {
      const batch = db.batch();
      allDupes.forEach(o => batch.delete(db.collection('orders').doc(o.id)));
      await batch.commit();
      console.log(`\nDeleted ${allDupes.length} duplicate BL docs.`);
    } else {
      console.log('\nRun with --delete to remove these docs.');
    }
  }
}

main().catch(console.error);
