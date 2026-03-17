'use strict';
/**
 * dedup-orders.js — Remove duplicate order docs with the same marketplaceOrderId.
 *
 * Keeps the "best" doc per marketplaceOrderId:
 *   1. Prefer the doc with omsStatus set (native OMS import)
 *   2. Among equal, prefer the doc with more fields (customer, items)
 *   3. Delete all other docs
 */

const { Firestore } = require('@google-cloud/firestore');
const db = new Firestore();

async function main() {
  const snap = await db.collection('orders')
    .select('marketplaceOrderId', 'marketplace', 'source', 'marketplaceKey',
            'omsStatus', 'status', 'statusLabel', 'customer', 'items',
            'totalAmount', 'createdAt', 'orderId')
    .limit(2000)
    .get();

  console.log(`Loaded ${snap.docs.length} orders`);

  // Group by (marketplace + marketplaceOrderId)
  const groups = new Map();
  for (const doc of snap.docs) {
    const d = doc.data();
    const mpOrderId = d.marketplaceOrderId || '';
    const mp = d.marketplace || d.source || '';
    if (!mpOrderId) continue;
    const key = `${mp}__${mpOrderId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ doc, data: d });
  }

  let totalDupes = 0;
  let deleted = 0;

  for (const [key, entries] of groups.entries()) {
    if (entries.length <= 1) continue;
    totalDupes++;
    console.log(`\nDuplicate: ${key} (${entries.length} docs)`);

    // Score each doc — higher = better to keep
    const scored = entries.map(({ doc, data }) => {
      let score = 0;
      if (data.omsStatus) score += 100;                          // Has OMS status
      if (data.marketplaceKey) score += 50;                      // Has marketplace key
      if (data.customer?.name && data.customer.name !== 'Unbekannt') score += 30; // Has customer
      if (Array.isArray(data.items) && data.items.length > 0) score += 30;        // Has items
      if (data.totalAmount > 0) score += 10;                     // Has total
      // Prefer later OMS statuses (shipped > pending etc.)
      const OMS_RANK = { pending: 0, confirmed: 1, picking: 2, picked: 3,
        packing: 4, packed: 5, shipped: 6, delivered: 7, completed: 8,
        cancelled: 9, returned: 10, on_hold: 11 };
      const oms = data.omsStatus || data.status || 'pending';
      score += (OMS_RANK[oms] ?? 0);
      return { doc, data, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const keep = scored[0];
    const remove = scored.slice(1);

    console.log(`  Keep: ${keep.doc.id} (score=${keep.score}, omsStatus=${keep.data.omsStatus || keep.data.status}, orderId=${keep.data.orderId || '—'})`);
    for (const r of remove) {
      console.log(`  Delete: ${r.doc.id} (score=${r.score}, status=${r.data.status}, statusLabel="${r.data.statusLabel || ''}")`);
      await r.doc.ref.delete();
      deleted++;
    }
  }

  console.log(`\nDone. Duplicate groups: ${totalDupes}, docs deleted: ${deleted}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
