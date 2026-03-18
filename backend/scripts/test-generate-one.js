'use strict';
const { generateInvoice } = require('../services/invoice-engine');
const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore();

(async () => {
  const statuses = ['picked', 'packed', 'shipped', 'delivered', 'completed'];
  for (const status of statuses) {
    const snap = await db.collection('orders')
      .where('tenantId', '==', 'default')
      .where('omsStatus', '==', status)
      .limit(5)
      .get();
    const unlinked = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(o => !o.invoiceId);
    if (unlinked.length) {
      const order = unlinked[0];
      console.log('Order:', order.id, order.marketplaceOrderId, 'amt:', order.totalAmount, 'status:', status);
      const result = await generateInvoice({ orderId: order.id, tenantId: 'default' });
      console.log('Result:', JSON.stringify(result));
      return;
    }
  }
  console.log('No unlinked eligible orders');
})().catch(console.error);
