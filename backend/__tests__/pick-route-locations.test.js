'use strict';
const { loadPickRouteBins } = require('../services/pick-route-locations');
function fixture(rows) {
  const reads = [];
  const fieldValue = (data, field) => field.split('.').reduce((x, key) => x?.[key], data);
  const snap = (id) => ({ id, exists: Boolean(rows[id]), data: () => rows[id] });
  const db = {
    getAll: async (...args) => args.filter(x => x.id).map(ref => snap(ref.id)),
    collection: name => {
      const filters = [];
      const query = { doc: id => ({ id }), select: () => query,
        where: (...args) => { filters.push(args); return query; },
        get: async () => { reads.push({ name, filters });
          return { docs: Object.entries(rows).filter(([,row]) => filters.every(([f,op,v]) =>
            op === 'in' ? v.includes(fieldValue(row,f)) : fieldValue(row,f) === v)).map(([id]) => snap(id)) }; },
      }; return query;
    },
  };
  return { db, reads };
}
const product = (sku, bin, tenantId = 'default') => ({ tenantId, identification: { sku }, storageBins: [{ code: bin, quantity: 1 }] });
describe('route locations from scoped product projections', () => {
  it('resolves product IDs and SKU-only marketplace orders without changing source documents', async () => {
    const { db, reads } = fixture({ p1: product('SKU-1', 'SEG0401A'), p2: product('SKU-2', 'LEG0101A') });
    const orders = [{ id: 'a', items: [{ productId: 'p1', quantity: 1 }] }, { id: 'b', items: [{ sku: 'SKU-2', quantity: 1 }] }];
    const result = await loadPickRouteBins(db, { tenantId: 'default', orders });
    expect(result.get('a')).toEqual(['SEG0401A']); expect(result.get('b')).toEqual(['LEG0101A']);
    expect(reads.every(r => r.filters.some(([f,op,v]) => f === 'tenantId' && op === '==' && v === 'default'))).toBe(true);
    expect(orders[0].routeBins).toBeUndefined();
  });
  it('does not use foreign IDs, ambiguous SKUs, depleted locations or stale order hints', async () => {
    const { db } = fixture({ foreign: product('SKU-X', 'XEG0101A', 'foreign'), a: product('DUP', 'SEG0101A'), b: product('DUP', 'LEG0101A'),
      empty: { ...product('EMPTY','SEG0101A'), storageBins: [{ code: 'SEG0101A', quantity: 0 }] } });
    const result = await loadPickRouteBins(db, { tenantId: 'default', orders: [
      { id: 'f', items: [{ productId: 'foreign', quantity: 1 }] }, { id: 'd', items: [{ sku: 'DUP', quantity: 1 }] },
      { id: 'e', items: [{ sku: 'EMPTY', quantity: 1 }] }, { id: 'h', items: [{ sku: 'MISSING', quantity: 1, pickHint: { binCode: 'SEG0101A' } }] },
    ] });
    expect([...result.values()]).toEqual([[],[],[],[]]);
  });
  it('does not read when there are no free candidates', async () => {
    const { db, reads } = fixture({});
    expect((await loadPickRouteBins(db,{tenantId:'default',orders:[]})).size).toBe(0); expect(reads).toEqual([]);
  });
  it('surfaces lookup failure before an assignment rather than quietly restoring inefficient FIFO', async () => {
    const { db } = fixture({}); db.getAll = async () => { throw new Error('unavailable'); };
    await expect(loadPickRouteBins(db,{tenantId:'default',orders:[{id:'a',items:[{productId:'p',quantity:1}]}]})).rejects.toThrow('unavailable');
  });
});
