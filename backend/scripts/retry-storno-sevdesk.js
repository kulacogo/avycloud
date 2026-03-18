'use strict';
const { Firestore } = require('@google-cloud/firestore');
const { getSecretValue } = require('../lib/secret-values');

const db = new Firestore();

(async () => {
  const token = await getSecretValue('SEVDESK_API_TOKEN');
  const headers = { Authorization: token, 'Content-Type': 'application/json' };

  const stornoSnap = await db.collection('invoices')
    .where('type', '==', 'storno')
    .where('tenantId', '==', 'default')
    .get();

  const stornoWithoutSevdesk = stornoSnap.docs
    .map(d => ({ _id: d.id, _ref: d.ref, ...d.data() }))
    .filter(s => !s.sevdeskId);

  console.log('Storno docs without SevDesk ID:', stornoWithoutSevdesk.length);

  let fixed = 0;
  for (const storno of stornoWithoutSevdesk) {
    if (!storno.originalInvoiceId) { console.log('  skip: no originalInvoiceId', storno._id); continue; }
    const origSnap = await db.collection('invoices').doc(storno.originalInvoiceId).get();
    if (!origSnap.exists) { console.log('  skip: orig not found', storno.originalInvoiceId); continue; }
    const orig = origSnap.data();
    if (!orig.sevdeskId) { console.log('  skip: no sevdeskId on', orig.invoiceNumber); continue; }

    try {
      const r = await fetch('https://my.sevdesk.de/api/v1/Invoice/' + orig.sevdeskId + '/cancelInvoice', {
        method: 'POST', headers,
      });
      const text = await r.text().catch(() => '');
      if (r.ok) {
        const data = JSON.parse(text);
        const cancelId = data?.objects?.id || null;
        await storno._ref.update({ sevdeskId: cancelId, updatedAt: new Date().toISOString() });
        console.log('  OK', orig.invoiceNumber, '→ SR', cancelId);
        fixed++;
      } else {
        console.log('  FAIL', orig.invoiceNumber, r.status, text.slice(0, 200));
      }
    } catch (err) {
      console.log('  ERR:', err.message);
    }
  }
  console.log('\nFixed:', fixed, '/', stornoWithoutSevdesk.length);
})().catch(console.error);
