#!/usr/bin/env node
'use strict';
const { kauflandRequest } = require('../lib/kaufland-api');

async function main() {
  const orderId = process.argv[2] || 'MFADA35';
  console.log('Fetching Kaufland order:', orderId);
  try {
    const result = await kauflandRequest('GET', `/orders/${orderId}`);
    console.log('Raw result keys:', Object.keys(result || {}));
    const order = result?.data || result;
    if (order) {
      console.log('Order keys:', Object.keys(order));
      console.log('Order status:', order.status);
      console.log('order_units count:', (order.order_units || []).length);
      if (order.order_units?.length) {
        console.log('First unit:', JSON.stringify(order.order_units[0], null, 2));
      } else {
        // Try listing order units differently
        console.log('No order_units in order — trying embedded units...');
        console.log('Order raw:', JSON.stringify(order, null, 2).slice(0, 1000));
      }
    } else {
      console.log('No order data returned');
    }
  } catch (err) {
    console.error('Error:', err.message);
    // Try fetching order units via /order-units endpoint
    try {
      const r2 = await kauflandRequest('GET', '/order-units', { query: { id_order: orderId, limit: 10 } });
      console.log('order-units endpoint result:', JSON.stringify(r2, null, 2).slice(0, 500));
    } catch (e2) {
      console.error('order-units also failed:', e2.message);
    }
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
