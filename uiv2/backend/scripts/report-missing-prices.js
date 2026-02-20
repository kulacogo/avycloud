/**
 * Reports products with missing or zero prices.
 * Usage: node backend/scripts/report-missing-prices.js
 */
const { firestore } = require('../lib/firestore');

async function main() {
  const snap = await firestore.collection('products').get();
  const missing = [];
  snap.forEach((doc) => {
    const data = doc.data() || {};
    const price = data?.details?.pricing?.lowest_price;
    const amount = price?.amount;
    if (!(typeof amount === 'number' && amount > 0)) {
      missing.push({
        id: doc.id,
        name: data?.identification?.name,
        sku: data?.identification?.sku || data?.details?.identifiers?.sku,
      });
    }
  });
  console.log('Products without valid price:', missing.length);
  missing.slice(0, 50).forEach((p) => console.log(p));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
