#!/usr/bin/env node
'use strict';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();
const DRY_RUN = process.env.DRY_RUN !== 'false';

const LABEL_MAP = {
  'storniert': 'cancelled',
  'zugestellt': 'delivered',
  'versendet': 'shipped',
};
const OMS_LABELS = {
  cancelled: 'Storniert', delivered: 'Zugestellt', shipped: 'Versendet',
};

async function main() {
  const snap = await db.collection('orders').get();
  const docs = snap.docs;
  console.log('Total docs:', docs.length);

  let deleted = 0, updated = 0;

  // 1. Delete 33543293 (BL duplicate of native eBay 09-14368-92522)
  const dup = docs.find(d => d.id === '33543293');
  if (dup) {
    console.log('Delete 33543293 (BL dup, number:', dup.data().number, ')');
    if (!DRY_RUN) await db.collection('orders').doc('33543293').delete();
    deleted++;
  }

  // 2. Fix all BL picked orders with known terminal statusLabel
  const blPicked = docs.filter(d => {
    const dd = d.data();
    return dd.baselinkerId && (dd.status === 'picked' || dd.omsStatus === 'picked') && dd.statusLabel;
  });

  const batchSize = 400;
  let batch = db.batch();
  let batchCount = 0;

  for (const doc of blPicked) {
    const dd = doc.data();
    const newStatus = LABEL_MAP[dd.statusLabel?.toLowerCase()];
    if (!newStatus) continue;

    const line = `  ${doc.id} | ${dd.marketplace} | ${dd.number || '—'} | ${dd.status} → ${newStatus}`;
    console.log(line);

    if (!DRY_RUN) {
      batch.update(doc.ref, {
        omsStatus: newStatus,
        status: newStatus,
        omsStatusLabel: OMS_LABELS[newStatus] || newStatus,
        statusLabel: OMS_LABELS[newStatus] || newStatus,
        updatedAt: new Date().toISOString(),
        ...(newStatus === 'shipped' && !dd.shippedAt ? { shippedAt: new Date().toISOString() } : {}),
        ...(newStatus === 'delivered' && !dd.deliveredAt ? { deliveredAt: new Date().toISOString() } : {}),
      });
      batchCount++;
      if (batchCount >= batchSize) {
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
      }
    }
    updated++;
  }

  if (!DRY_RUN && batchCount > 0) await batch.commit();

  console.log(`\n=== Summary${DRY_RUN ? ' (DRY RUN — set DRY_RUN=false to apply)' : ''} ===`);
  console.log(`Deleted: ${deleted} | Updated: ${updated}`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
