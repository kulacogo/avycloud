#!/usr/bin/env node
'use strict';
/**
 * Inspect one old BaseLinker eBay order to understand its structure.
 *   GCLOUD_PROJECT=avycloud node backend/scripts/inspect-bl-order.js
 */
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'avycloud' });
const db = admin.firestore();

async function main() {
  const docIds = ['33557600', '33536018', '33468106', '32783516'];
  for (const id of docIds) {
    const doc = await db.collection('orders').doc(id).get();
    if (!doc.exists) {
      console.log(`${id}: NOT FOUND`);
      continue;
    }
    const d = doc.data();
    console.log(`\n=== ${id} ===`);
    console.log(JSON.stringify({
      orderId: d.orderId,
      marketplaceKey: d.marketplaceKey,
      marketplaceOrderId: d.marketplaceOrderId,
      externalOrderId: d.externalOrderId,
      source: d.source,
      marketplace: d.marketplace,
      status: d.status,
      omsStatus: d.omsStatus,
      createdAt: d.createdAt,
      customer_name: d.customer?.name,
      itemCount: d.items?.length,
      // top-level keys except items/raw
      keys: Object.keys(d).filter(k => !['items','raw','customer'].includes(k)),
    }, null, 2));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
