#!/usr/bin/env node
'use strict';
const { kauflandRequest } = require('../lib/kaufland-api');

async function main() {
  // Test single order
  console.log('=== Single order /orders/MFADA35 ===');
  const single = await kauflandRequest('GET', '/orders/MFADA35');
  console.log('result.data type:', typeof single.data);
  console.log('result.data keys:', Object.keys(single.data || {}));
  const orderData = single.data?.data || single.data;
  console.log('orderData keys:', Object.keys(orderData || {}));
  console.log('order_units count:', (orderData?.order_units || []).length);
  if (orderData?.order_units?.length) {
    const u = orderData.order_units[0];
    console.log('First unit status:', u.status, '| keys:', Object.keys(u).join(','));
  }

  // Test list
  console.log('\n=== List /orders ===');
  const list = await kauflandRequest('GET', '/orders', { query: { limit: 2, sort: 'ts_created:desc' } });
  console.log('result.data type:', typeof list.data);
  console.log('result.data keys:', Object.keys(list.data || {}));
  const listData = list.data?.data || list.data;
  console.log('listData is array:', Array.isArray(listData), '| length:', Array.isArray(listData) ? listData.length : '—');
  if (Array.isArray(listData) && listData.length) {
    console.log('First order keys:', Object.keys(listData[0]).join(','));
    const units = listData[0]?.order_units || [];
    console.log('First order units count:', units.length);
    if (units.length) console.log('First unit status:', units[0].status);
  }
  console.log('pagination:', list.data?.pagination || 'none');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
