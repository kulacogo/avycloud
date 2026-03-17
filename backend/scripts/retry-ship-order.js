'use strict';
/**
 * retry-ship-order.js
 * Retries shipping for an order stuck in 'packed' state (no trackingNumber).
 * Usage: node scripts/retry-ship-order.js <firestoreDocId>
 */
const { Firestore } = require('@google-cloud/firestore');

const db = new Firestore();
const orderId = process.argv[2];

if (!orderId) {
  console.error('Usage: node scripts/retry-ship-order.js <firestoreDocId>');
  process.exit(1);
}

async function main() {
  const { shipOrder } = require('../services/shipping-engine');
  const { transitionOrder } = require('../services/order-state-machine');

  const snap = await db.collection('orders').doc(orderId).get();
  if (!snap.exists) { console.error('Order not found:', orderId); process.exit(1); }

  const data = snap.data();
  console.log(`Order: ${data.marketplaceOrderId || orderId}`);
  console.log(`  omsStatus: ${data.omsStatus}, trackingNumber: ${data.trackingNumber || 'none'}`);
  console.log(`  customer.zip type: ${typeof data.customer?.zip}, value: ${data.customer?.zip}`);

  if (data.trackingNumber) {
    console.log('Order already has tracking number — nothing to do.');
    return;
  }

  console.log('Calling shipOrder...');
  const result = await shipOrder({ orderId, tenantId: 'default' });
  console.log('shipOrder result:', JSON.stringify(result, null, 2));

  const hasTracking = !!result.trackingNumber;
  const hasLabel = !!result.labelUrl;

  if (hasTracking || hasLabel) {
    const note = hasTracking
      ? `Versandlabel erstellt (${result.carrier || 'unknown'}) — retry via script`
      : `Versandlabel erstellt (${result.carrier || 'unknown'}) — Tracking ausstehend`;
    await transitionOrder({
      tenantId: 'default',
      orderId,
      toStatus: 'shipped',
      actor: { uid: 'system', email: 'script' },
      note,
      timestamps: { shippedAt: new Date().toISOString() },
    });
    console.log(`Done. Order transitioned to shipped. Tracking: ${result.trackingNumber || 'pending'}`);
    console.log('Label URL:', result.labelUrl);

    // Push tracking to marketplace (only if tracking number available)
    if (hasTracking) {
      try {
        const { pushTrackingToMarketplace } = require('../services/marketplace-tracking');
        const push = await pushTrackingToMarketplace({
          orderId,
          trackingNumber: result.trackingNumber,
          carrier: result.carrier || '',
        });
        console.log('Marketplace push:', JSON.stringify(push));
      } catch (err) {
        console.warn('Marketplace push failed:', err.message);
      }
    } else {
      console.warn('No tracking number — marketplace push skipped. Update tracking manually once DHL assigns a number.');
    }
  } else {
    console.warn('No label or tracking number returned — order stays in current status.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
