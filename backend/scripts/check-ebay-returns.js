/* eslint-disable no-console */
/**
 * Quick script to count eBay returns/cancellations via Fulfillment API.
 */
const { getValidEbayAccessToken } = require('../lib/ebay-oauth');

async function run() {
  const { accessToken } = await getValidEbayAccessToken();
  let allOrders = [];
  let offset = 0;
  const limit = 200;

  // Paginate through all orders
  while (true) {
    const url = `https://api.ebay.com/sell/fulfillment/v1/order?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_DE',
      },
    });

    if (!res.ok) {
      console.error('eBay API error:', res.status, (await res.text()).slice(0, 300));
      break;
    }

    const json = await res.json();
    const orders = json.orders || [];
    allOrders = allOrders.concat(orders);
    console.log(`Fetched ${orders.length} orders (offset=${offset}, total=${json.total})`);

    if (allOrders.length >= (json.total || 0) || orders.length < limit) break;
    offset += limit;
  }

  console.log(`\nTotal eBay orders: ${allOrders.length}`);

  // Count cancellations
  let cancelCount = 0;
  const cancelOrders = [];
  allOrders.forEach((o) => {
    const cs = o.cancelStatus?.cancelState || 'NONE_REQUESTED';
    if (cs !== 'NONE_REQUESTED') {
      cancelCount++;
      cancelOrders.push({ id: o.orderId, status: cs, date: o.creationDate });
    }
  });

  // Count refunds (return indicator)
  let refundCount = 0;
  const refundOrders = [];
  allOrders.forEach((o) => {
    const hasRefund = (o.lineItems || []).some((li) => li.refunds && li.refunds.length > 0);
    if (hasRefund) {
      refundCount++;
      const titles = (o.lineItems || [])
        .filter((li) => li.refunds?.length)
        .map((li) => li.title?.slice(0, 50));
      refundOrders.push({ id: o.orderId, date: o.creationDate, titles });
    }
  });

  console.log(`\n=== eBay Retouren/Stornos ===`);
  console.log(`Stornierungen: ${cancelCount}`);
  cancelOrders.forEach((c) => console.log(`  ${c.date?.slice(0, 10)} | ${c.id} | ${c.status}`));

  console.log(`\nBestellungen mit Erstattungen (Retouren): ${refundCount}`);
  refundOrders.forEach((r) => {
    console.log(`  ${r.date?.slice(0, 10)} | ${r.id} | ${r.titles.join(', ')}`);
  });
}

run().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
