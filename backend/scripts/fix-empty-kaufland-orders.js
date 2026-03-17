'use strict';
/**
 * fix-empty-kaufland-orders.js
 * Backfills customer + items for Kaufland orders that were saved without data
 * (because the list endpoint didn't include order_units/buyer).
 */

const { Firestore } = require('@google-cloud/firestore');
const { kauflandRequest } = require('../lib/kaufland-api');

const db = new Firestore();

async function main() {
  // Find all Kaufland orders missing customer or items
  const snap = await db.collection('orders').get();
  const empty = snap.docs
    .map(d => ({ firestoreId: d.id, ...d.data() }))
    .filter(o => {
      const isKl = o.marketplace === 'kaufland' || o.source === 'kaufland';
      const hasNoCustomer = !o.customer || !o.customer.name || o.customer.name === 'Unbekannt';
      const hasNoItems = !o.items || o.items.length === 0;
      return isKl && (hasNoCustomer || hasNoItems);
    });

  console.log(`Found ${empty.length} empty Kaufland orders to fix`);

  for (const order of empty) {
    const orderId = order.marketplaceOrderId;
    if (!orderId) { console.log(`Skip ${order.firestoreId}: no marketplaceOrderId`); continue; }

    try {
      const result = await kauflandRequest('GET', `/orders/${orderId}`);
      const full = result?.data?.data || result?.data || result;
      if (!full) { console.log(`No detail data for ${orderId}`); continue; }

      const units = full.order_units || [];
      const buyer = full.buyer || {};
      // Kaufland API: addresses are at root level, NOT inside buyer
      const shippingAddr = full.shipping_address || buyer.shipping_address || {};
      const billingAddr = full.billing_address || buyer.billing_address || {};

      const items = units.map((unit, idx) => ({
        id: `${order.firestoreId}-${idx + 1}`,
        name: unit.product?.title || unit.offer_id || 'Unbekannter Artikel',
        sku: unit.id_offer || null,
        quantity: parseInt(unit.quantity || '1', 10),
        priceBrutto: parseFloat(unit.price || '0') / 100,
        currency: 'EUR',
        unitId: unit.id_order_unit || null,
        ean: unit.ean || null,
        status: unit.status || null,
      }));

      const totalAmount = items.reduce((sum, i) => sum + (i.priceBrutto * i.quantity), 0);

      const customerName = ([shippingAddr.first_name, shippingAddr.last_name].filter(Boolean).join(' ')
        || [billingAddr.first_name, billingAddr.last_name].filter(Boolean).join(' ')
        || buyer.name || '').trim() || 'Unbekannt';

      const customer = {
        name: customerName,
        street: [shippingAddr.street, shippingAddr.house_number].filter(Boolean).join(' ') || null,
        city: shippingAddr.city || billingAddr.city || null,
        zip: shippingAddr.postcode || billingAddr.postcode || null,
        country: shippingAddr.country || billingAddr.country || 'DE',
        phone: shippingAddr.phone || billingAddr.phone || buyer.phone || null,
        email: buyer.email || null,
      };

      const updates = { customer, items, totalAmount };
      if (full.ts_created) updates.createdAt = full.ts_created;

      await db.collection('orders').doc(order.firestoreId).update(updates);
      console.log(`Fixed ${orderId} → ${customerName}, ${items.length} items, ${totalAmount.toFixed(2)} EUR`);
    } catch (err) {
      console.log(`FAILED ${orderId}: ${err.message}`);
    }
  }

  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
