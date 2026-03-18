'use strict';
const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore();

(async () => {
  const snap = await db.collection('invoices').where('tenantId', '==', 'default').get();
  let updated = 0;
  const batch = db.batch();
  for (const doc of snap.docs) {
    const d = doc.data();
    if (d.status === 'erstellt' || d.status === 'gesendet') {
      batch.update(doc.ref, { status: 'offen', updatedAt: new Date().toISOString() });
      updated++;
    }
  }
  if (updated > 0) await batch.commit();
  console.log('Updated:', updated);
})().catch(console.error);
