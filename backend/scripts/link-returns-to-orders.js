/* eslint-disable no-console */
/**
 * link-returns-to-orders.js
 *
 * Links all unlinked returns to their matching orders via marketplaceOrderId.
 */
const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT || 'avycloud' });

async function run() {
  const retSnap = await db.collection('returns').get();
  let linked = 0;
  let unlinked = 0;
  let fixed = 0;
  let noMatch = 0;

  for (const doc of retSnap.docs) {
    const d = doc.data();
    if (d.orderId) {
      linked++;
      continue;
    }

    unlinked++;
    const mpOrderId = d.marketplaceOrderId;
    if (!mpOrderId) {
      noMatch++;
      console.log('  No marketplaceOrderId:', d.marketplace, doc.id);
      continue;
    }

    // Try to find matching order
    const orderSnap = await db.collection('orders')
      .where('marketplaceOrderId', '==', mpOrderId)
      .limit(1)
      .get();

    if (!orderSnap.empty) {
      const order = orderSnap.docs[0];
      await doc.ref.update({
        orderId: order.id,
        orderAmount: order.data().totalAmount || 0,
      });
      fixed++;
      console.log('  Linked:', d.marketplace, mpOrderId, '→ Order', order.id);
    } else {
      noMatch++;
      console.log('  No match:', d.marketplace, mpOrderId, '-', (d.product?.name || '').slice(0, 50));
    }
  }

  console.log('');
  console.log('=== Ergebnis ===');
  console.log('Retouren gesamt:', retSnap.size);
  console.log('Bereits verknüpft:', linked);
  console.log('Unverknüpft:', unlinked);
  console.log('Jetzt verknüpft:', fixed);
  console.log('Keine Order gefunden:', noMatch);
}

run().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
