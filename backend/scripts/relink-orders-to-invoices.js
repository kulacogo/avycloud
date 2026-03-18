'use strict';
/**
 * Re-links orders to their matching SevDesk-imported invoices by amount.
 * Useful after cleanup of locally-generated invoices.
 */
const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore();
const TENANT_ID = 'default';

(async () => {
  console.log('\nRe-linking orders to SevDesk-imported invoices...\n');

  // Load orders without invoiceId in eligible states
  const ELIGIBLE = ['picked', 'packed', 'shipped', 'delivered', 'completed'];
  const unlinkedOrders = [];
  for (const status of ELIGIBLE) {
    const snap = await db.collection('orders')
      .where('tenantId', '==', TENANT_ID)
      .where('omsStatus', '==', status)
      .get();
    for (const d of snap.docs) {
      const order = { _id: d.id, _ref: d.ref, ...d.data() };
      if (!order.invoiceId) unlinkedOrders.push(order);
    }
  }

  console.log(`Unlinked orders: ${unlinkedOrders.length}`);

  // Load all SevDesk-imported invoices that have no orderId or are unmatched
  const invSnap = await db.collection('invoices')
    .where('tenantId', '==', TENANT_ID)
    .where('source', '==', 'sevdesk_import')
    .get();

  // Index available invoices by gross amount
  const availableByAmount = new Map();
  for (const d of invSnap.docs) {
    const inv = { _id: d.id, _ref: d.ref, ...d.data() };
    if (inv.orderId) continue; // already linked
    const gross = inv.amountGross || 0;
    if (!availableByAmount.has(gross)) availableByAmount.set(gross, []);
    availableByAmount.get(gross).push(inv);
  }

  let linked = 0;
  for (const order of unlinkedOrders) {
    const total = order.totalAmount || 0;
    if (total <= 0) continue;

    // Find invoice with matching gross amount within ±€1
    let match = null;
    for (const [gross, invList] of availableByAmount) {
      if (Math.abs(gross - total) < 1.0) {
        match = invList[0];
        invList.shift();
        if (invList.length === 0) availableByAmount.delete(gross);
        break;
      }
    }

    if (match) {
      // Link order → invoice
      await order._ref.update({
        invoiceId: match._id,
        invoiceNumber: match.invoiceNumber || null,
        sevdeskInvoiceId: match.sevdeskId || null,
        updatedAt: new Date().toISOString(),
      });
      // Link invoice → order
      await match._ref.update({
        orderId: order._id,
        updatedAt: new Date().toISOString(),
      });
      console.log(`  ✓ Order ${order._id} → Invoice ${match.invoiceNumber} (${match.amountGross}€)`);
      linked++;
    } else {
      console.log(`  ⚠ No match for order ${order._id} ${order.marketplaceOrderId || ''} (${total}€)`);
    }
  }

  console.log(`\nLinked: ${linked} / ${unlinkedOrders.length}\n`);
})().catch(console.error);
