'use strict';
const { Firestore } = require('@google-cloud/firestore');
const { getSecretValue } = require('../lib/secret-values');
const db = new Firestore();

(async () => {
  const token = await getSecretValue('SEVDESK_API_TOKEN');
  const headers = { Authorization: token, 'Content-Type': 'application/json' };

  const snap = await db.collection('invoices').where('tenantId', '==', 'default').get();
  const broken = snap.docs
    .map(d => ({ _id: d.id, _ref: d.ref, ...d.data() }))
    .filter(inv => !inv.invoiceNumber && !inv.type && inv.source !== 'sevdesk_import');

  console.log('Broken entries (no invoiceNumber, not correction, not import):', broken.length);

  for (const inv of broken) {
    // Delete from SevDesk if exists
    if (inv.sevdeskId) {
      try {
        const r = await fetch('https://my.sevdesk.de/api/v1/Invoice/' + inv.sevdeskId, { method: 'DELETE', headers });
        console.log('  SevDesk DELETE', inv.sevdeskId, r.status);
      } catch (e) { console.log('  SevDesk DELETE error:', e.message); }
    }
    // Unlink order
    if (inv.orderId) {
      try {
        const orderSnap = await db.collection('orders').doc(inv.orderId).get();
        if (orderSnap.exists && orderSnap.data().invoiceId === inv._id) {
          await orderSnap.ref.update({ invoiceId: null, invoiceNumber: null, updatedAt: new Date().toISOString() });
          console.log('  Unlinked order', inv.orderId);
        }
      } catch (e) {}
    }
    await inv._ref.delete();
    console.log('  Deleted Firestore doc', inv._id);
  }
  console.log('Done:', broken.length, 'removed');
})().catch(console.error);
