const { buildUnassignmentPlan, applyUnassignmentPlan } = require('../lib/warehouse-zone-unassign');

const row = (id, data) => ({ id, data, version: 'v1' });
const fixture = () => ({
  tenantId: 'default', zone: 'X', operationId: 'move-x-test', now: '2026-09-22T14:00:00Z',
  bins: [row('XEG0101A', { zone: 'X', products: [{ productId: 'p1', sku: 'SKU-1', quantity: 2 }], productCount: 2 })],
  products: [row('p1', { tenantId: 'default', identification: { sku: 'SKU-1' }, inventory: { quantity: 4 }, storage: { binCode: 'XEG0101A', zone: 'X' }, storageBins: [{ code: 'XEG0101A', zone: 'X', quantity: 2 }, { code: 'LEG0205C', zone: 'L', quantity: 1 }] })],
});

describe('neutral zone unassignment', () => {
  it('removes only X locations, retains other locations and never patches inventory', () => {
    const input = fixture();
    const before = structuredClone(input);
    const plan = buildUnassignmentPlan(input);
    expect(plan.products[0].patch).toEqual({
      storage: expect.objectContaining({ binCode: 'LEG0205C', quantity: 1 }),
      storageBins: [{ code: 'LEG0205C', zone: 'L', quantity: 1 }],
      'ops.relocation': { unassignedQuantity: 2, operationId: 'move-x-test', updatedAt: input.now, reason: 'zone_unassign' },
    });
    expect(plan.summary).toMatchObject({ units: 2, productCount: 1, orphanUnits: 0, inventoryBefore: 4 });
    expect(input).toEqual(before);
  });

  it('clears primary storage when no other BIN exists and adds to prior unassigned quantity', () => {
    const input = fixture();
    input.products[0].data.storageBins.pop();
    input.products[0].data.ops = { relocation: { unassignedQuantity: 1, note: 'keep' } };
    const plan = buildUnassignmentPlan(input);
    expect(plan.products[0].patch.storage).toBeNull();
    expect(plan.products[0].patch['ops.relocation']).toMatchObject({ unassignedQuantity: 3, note: 'keep' });
  });

  it('preserves a missing-product entry in the durable orphan manifest, without creating a product', () => {
    const input = fixture();
    input.bins[0].data.products.push({ productId: 'missing', sku: 'SKU-M', quantity: 1, title: 'Original title' });
    input.bins[0].data.productCount = 3;
    const plan = buildUnassignmentPlan(input);
    expect(plan.orphans).toEqual([{ productId: 'missing', sourceBin: 'XEG0101A', entry: { productId: 'missing', sku: 'SKU-M', quantity: 1, title: 'Original title' } }]);
    expect(plan.products).toHaveLength(1);
    expect(plan.summary).toMatchObject({ units: 3, orphanUnits: 1 });
  });

  it('does not mistake XS or XQ for X', () => {
    const input = fixture();
    input.products[0].data.storageBins = [{ code: 'XSGA0101A', zone: 'XS', quantity: 1 }, { code: 'XQGA0101A', zone: 'XQ', quantity: 1 }];
    expect(() => buildUnassignmentPlan(input)).toThrow(/mismatch/);
  });

  it.each(['other', '', null])('rejects wrong or missing product tenant %j', (tenantId) => {
    const input = fixture(); input.products[0].data.tenantId = tenantId;
    expect(() => buildUnassignmentPlan(input)).toThrow(/tenant/);
  });

  it.each([NaN, -1, '2', undefined])('rejects unverifiable BIN quantities %j', (quantity) => {
    const input = fixture(); input.bins[0].data.products[0].quantity = quantity;
    expect(() => buildUnassignmentPlan(input)).toThrow(/quantity/);
  });

  it('refuses mismatching product and BIN allocations before any mutation', () => {
    const input = fixture(); input.products[0].data.storageBins[0].quantity = 1;
    expect(() => buildUnassignmentPlan(input)).toThrow(/mismatch/);
  });

  it('refuses a relocation that exceeds the unchanged stock', () => {
    const input = fixture(); input.products[0].data.inventory.quantity = 1;
    expect(() => buildUnassignmentPlan(input)).toThrow(/inventory/);
  });

  it('refuses foreign warehouse ownership and inconsistent zone metadata', () => {
    const input = fixture(); input.bins[0].data.tenantId = 'foreign';
    expect(() => buildUnassignmentPlan(input)).toThrow(/tenant/);
    input.bins[0].data.tenantId = 'default'; input.bins[0].data.zone = 'XS';
    expect(() => buildUnassignmentPlan(input)).toThrow(/zone/);
  });

  it('removes an otherwise stale zero-quantity primary assignment', () => {
    const input = fixture(); input.bins = []; input.products[0].data.storageBins = [];
    const plan = buildUnassignmentPlan(input);
    expect(plan.products[0].patch.storage).toBeNull();
    expect(plan.summary.units).toBe(0);
  });
});

describe('atomic application', () => {
  function setup() {
    const input = fixture();
    const plan = buildUnassignmentPlan(input);
    const writes = [];
    const ref = (collection, id) => ({ path: `${collection}/${id}`, id });
    const docs = new Map([
      ...input.bins.map(d => [`warehouseBins/${d.id}`, d]),
      ...input.products.map(d => [`products_v2/${d.id}`, d]),
    ]);
    const snapshot = r => ({ id: r.id, ref: r, exists: docs.has(r.path), updateTime: { toMillis: () => 1, toDate: () => new Date(1) }, data: () => docs.get(r.path)?.data });
    const tx = {
      get: async r => {
        if (writes.length) throw new Error('Read after write');
        if (r.query) return { docs: input.bins.map(d => snapshot(ref('warehouseBins', d.id))) };
        return snapshot(r);
      },
      update: (r, data) => writes.push(['update', r.path, data]),
      create: (r, data) => writes.push(['create', r.path, data]),
    };
    const db = { collection: name => ({ doc: id => ref(name, id), where: () => ({ query: true }) }), runTransaction: fn => fn(tx) };
    const saveProductV2 = vi.fn(async (p, opts) => opts.transaction.update(opts.productSnapshot.ref, opts.warehousePatch));
    // The production manifest stores the full Timestamp JSON, not rounded millis.
    plan.bins.forEach(d => { d.version = '1:0'; }); plan.products.forEach(d => { d.version = '1:0'; });
    return { plan, db, tx, writes, docs, saveProductV2, input };
  }

  it('stages every product through saveProductV2 and a delta-zero durable operation in one transaction', async () => {
    const s = setup();
    await applyUnassignmentPlan(s.plan, { db: s.db, saveProductV2: s.saveProductV2, versionOf: () => '1:0' });
    expect(s.saveProductV2).toHaveBeenCalledTimes(1);
    expect(s.writes.find(x => x[1] === 'warehouseBins/XEG0101A')[2]).toMatchObject({ products: [], productCount: 0 });
    expect(s.writes.find(x => x[1].startsWith('warehouseRelocations/'))[2]).toMatchObject({ tenantId: 'default', status: 'completed', orphanEntries: [] });
    expect(s.writes.find(x => x[1].startsWith('warehouseEvents/'))[2]).toMatchObject({ delta: 0, productId: 'p1', tenantId: 'default' });
  });

  it('rejects changes since the backup without staging any writes', async () => {
    const s = setup();
    await expect(applyUnassignmentPlan(s.plan, { db: s.db, saveProductV2: s.saveProductV2, versionOf: () => 'new' })).rejects.toThrow(/changed/);
    expect(s.writes).toHaveLength(0);
  });

  it('rejects a new BIN since the backup', async () => {
    const s = setup(); s.input.bins.push(row('XEG0201A', { zone: 'X', products: [], productCount: 0 }));
    await expect(applyUnassignmentPlan(s.plan, { db: s.db, saveProductV2: s.saveProductV2, versionOf: () => '1:0' })).rejects.toThrow(/BIN set/);
    expect(s.writes).toHaveLength(0);
  });

  it('returns the completed operation without repeating a write', async () => {
    const s = setup();
    s.docs.set('warehouseRelocations/default_move-x-test', { data: { tenantId: 'default', zone: 'X', status: 'completed', summary: s.plan.summary } });
    expect(await applyUnassignmentPlan(s.plan, { db: s.db, saveProductV2: s.saveProductV2 })).toMatchObject({ alreadyApplied: true, units: 2 });
    expect(s.writes).toHaveLength(0);
  });

  it('rejects an orphan that becomes a product before commit', async () => {
    const s = setup();
    s.plan.orphans.push({ productId: 'new-product', sourceBin: 'XEG0101A', entry: { quantity: 1 } });
    s.docs.set('products_v2/new-product', { data: { tenantId: 'default' } });
    await expect(applyUnassignmentPlan(s.plan, { db: s.db, saveProductV2: s.saveProductV2, versionOf: () => '1:0' })).rejects.toThrow(/Orphan product now exists/);
    expect(s.writes).toHaveLength(0);
  });
});

describe('operator guard', () => {
  const { parseArgs } = require('../scripts/unassign-warehouse-zone');
  it('requires the exact authorized zone and an absolute private backup path', () => {
    expect(() => parseArgs(['--zone', 'XS', '--tenant', 'default', '--operation', 'x', '--backup', '/tmp/b.json'])).toThrow();
    expect(() => parseArgs(['--zone', 'X', '--tenant', 'default', '--operation', 'x', '--backup', 'relative.json'])).toThrow();
    expect(parseArgs(['--zone', 'X', '--tenant', 'default', '--operation', 'x', '--backup', '/tmp/b.json']).apply).toBe(false);
  });
});
