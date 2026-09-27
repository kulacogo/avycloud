'use strict';
const { readEbayListingPages } = require('../lib/ebay-listing-pages');

function fixture(rows, failPage = -1) {
  const calls = [];
  let reads = 0;
  const build = (filters = [], after = '', size = 100) => ({
    where: (field, op, value) => { calls.push([field, value]); return build([...filters, [field, value]], after, size); },
    limit: (n) => build(filters, after, n),
    startAfter: (doc) => build(filters, doc.id, size),
    get: async () => {
      if (reads++ === failPage) throw new Error('read unavailable');
      const docs = rows.filter(r => r.id > after && filters.every(([f, v]) => r[f] === v)).slice(0, size)
        .map(row => ({ id: row.id, data: () => row }));
      return { docs };
    },
  });
  return { firestore: { collection: () => build() }, calls };
}

it('findet aktive Relists auch nach mehreren vollen Seiten historischer Angebote', async () => {
  const rows = Array.from({ length: 207 }, (_, i) => ({ id: String(i).padStart(4, '0'), sku: 'SKU-A', active: i === 206 }));
  const result = await readEbayListingPages({ ...fixture(rows), sku: 'SKU-A', tenantId: 'default' });
  expect(result.docs).toHaveLength(207);
  expect(result.docs.filter(d => d.data().active).map(d => d.id)).toEqual(['0206']);
});
it('liefert bei Fehler auf Folgeseite keine scheinbar vollständige Teilmenge', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => ({ id: String(i).padStart(4, '0'), sku: 'SKU-A' }));
  await expect(readEbayListingPages({ ...fixture(rows, 1), sku: 'SKU-A', tenantId: 'default' })).rejects.toThrow('read unavailable');
});
it('grenzt Mandanten ab und akzeptiert unmarkierte Altspiegel ausschließlich für default', async () => {
  const rows = [{ id: 'a', sku: 'SKU-A' }, { id: 'b', sku: 'SKU-A', tenantId: 'other' }];
  expect((await readEbayListingPages({ ...fixture(rows), sku: 'SKU-A', tenantId: 'default' })).docs.map(d => d.id)).toEqual(['a']);
  const other = fixture(rows);
  expect((await readEbayListingPages({ ...other, sku: 'SKU-A', tenantId: 'other' })).docs.map(d => d.id)).toEqual(['b']);
  expect(other.calls).toContainEqual(['tenantId', 'other']);
  await expect(readEbayListingPages({ ...fixture(rows), sku: 'SKU-A' })).rejects.toThrow('tenantId');
});
