'use strict';

/** Complete SKU mirror read, before any marketplace changes. Never returns a
 * truncated success. The legacy single-account mirror predates tenantId:
 * its existing SKU query is retained only for default, with a document gate.
 * Every other tenant gets a tenantId query and never sees unmarked rows.
 */
async function readEbayListingPages({ firestore, sku, tenantId }) {
  if (!tenantId) throw new Error('eBay listing lookup requires tenantId');
  if (!sku) return { docs: [], empty: true };
  let base = firestore.collection('ebayListingsLive').where('sku', '==', sku);
  if (tenantId !== 'default') base = base.where('tenantId', '==', tenantId);
  const docs = [];
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 50; page += 1) {
    let query = base.limit(100);
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    for (const doc of snapshot.docs) {
      if (seen.has(doc.id)) throw new Error('eBay listing pagination did not advance');
      seen.add(doc.id);
      const owner = doc.data()?.tenantId || 'default';
      if (owner === tenantId) docs.push(doc);
    }
    if (snapshot.docs.length < 100) return { docs, empty: docs.length === 0 };
    cursor = snapshot.docs[snapshot.docs.length - 1];
  }
  throw new Error('eBay listing lookup incomplete: read budget exceeded');
}

module.exports = { readEbayListingPages };
