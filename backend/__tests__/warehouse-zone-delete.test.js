const express = require('express');
const request = require('supertest');
require('./api/_patchGcp');

let store;
let retryWith;
let failCommit;
let autoId = 0;
const writes = [];
const ref = (collection, id = `event-${++autoId}`) => ({ collection, id });
const snapshot = (doc) => ({
  ...doc, ref: doc, exists: store[doc.collection]?.[doc.id] !== undefined,
  data: () => structuredClone(store[doc.collection]?.[doc.id]),
});
const query = (collection, filters = []) => ({
  collection, filters,
  where: (field, op, value) => query(collection, [...filters, [field, value]]),
});
const db = {
  collection: (name) => ({ ...query(name), doc: (id) => ref(name, id) }),
  runTransaction: async (fn) => {
    const pending = [];
    const tx = {
      get: async (target) => {
        if (pending.length) throw new Error('Read after write');
        if (!target.filters) return snapshot(target);
        const docs = Object.entries(store[target.collection] || {})
          .filter(([, data]) => target.filters.every(([key, value]) => data[key] === value))
          .map(([id]) => snapshot(ref(target.collection, id)));
        return { docs, size: docs.length, empty: !docs.length };
      },
      delete: (doc) => pending.push(['delete', doc]),
      set: (doc, data) => pending.push(['set', doc, data]),
    };
    const result = await fn(tx);
    if (retryWith) {
      const mutate = retryWith;
      retryWith = null;
      mutate();
      return db.runTransaction(fn);
    }
    if (failCommit) throw new Error('Commit failed');
    pending.forEach(([op, doc, data]) => {
      if (op === 'delete') delete store[doc.collection][doc.id];
      else (store[doc.collection] ||= {})[doc.id] = data;
    });
    writes.push(...pending);
    return result;
  },
};
require.cache[require.resolve('@google-cloud/firestore')].exports.Firestore = function () { return db; };
function patch(module, exports) {
  const id = require.resolve(module);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
patch('../lib/firestore', { getProduct: vi.fn(), adjustPendingIntakeQuantity: vi.fn() });
patch('../services/label-printer', {});
const permissions = [];
patch('../lib/rbac', { requirePermission: (resource, action) => {
  return (req, res, next) => {
    permissions.push([resource, action]);
    if (req.headers['x-deny']) return res.sendStatus(403);
    next();
  };
} });
const { deleteWarehouseZone } = require('../lib/warehouse');
const app = express();
app.use((req, res, next) => { req.user = { tenantId: req.headers['x-tenant'] || 'default', uid: 'test-user' }; next(); });
app.use('/api/warehouse', require('../routes/warehouse').router);
const endpoint = '/api/warehouse/layouts/XQ/GA';
const remove = (opts = {}) => deleteWarehouseZone('XQ', 'GA', { tenantId: 'default', dryRun: false, ...opts });
const addBin = (id = 'XQGA0101A', data = {}) => {
  store.warehouseBins[id] = { zone: 'XQ', etage: 'GA', productCount: 0, products: [], ...data };
};

beforeEach(() => {
  store = { warehouseZones: { XQ_GA: { zone: 'XQ', etage: 'GA' } }, warehouseBins: {}, warehouseEvents: {} };
  writes.length = 0;
  permissions.length = 0;
  retryWith = null;
  failCommit = false;
});

describe('deleteWarehouseZone', () => {
  it('removes a zone with zero bins and records the tenant and actor atomically', async () => {
    const result = await remove({ actor: { uid: 'u1' } });
    expect(result).toMatchObject({ zone: 'XQ', etage: 'GA', deleted: 0, zoneDeleted: true, dryRun: false });
    expect(store.warehouseZones.XQ_GA).toBeUndefined();
    expect(Object.values(store.warehouseEvents)).toEqual([expect.objectContaining({ type: 'zone_delete', tenantId: 'default', actor: { uid: 'u1' } })]);
  });

  it('previews zero-bin zones without creating, deleting or updating anything', async () => {
    expect(await remove({ dryRun: true })).toMatchObject({ dryRun: true, zoneDeleted: false, binCodes: [] });
    expect(writes).toHaveLength(0);
    expect(store.warehouseZones.XQ_GA).toBeDefined();
  });

  it('defaults to a read-only preview', async () => {
    expect(await deleteWarehouseZone('XQ', 'GA', { tenantId: 'default' })).toMatchObject({ dryRun: true });
    expect(writes).toHaveLength(0);
  });

  it('deletes empty bins and zero-quantity remnants, preserving another floor', async () => {
    addBin();
    addBin('XQGA0101B', { products: [{ productId: 'p1', quantity: 0 }] });
    addBin('XQEG0101A', { etage: 'EG', productCount: 4 });
    store.warehouseZones.XQ_EG = { zone: 'XQ', etage: 'EG' };
    const result = await remove();
    expect(result.deleted).toBe(2);
    expect(Object.keys(store.warehouseBins)).toEqual(['XQEG0101A']);
    expect(store.warehouseZones.XQ_EG).toBeDefined();
  });

  it.each([
    { productCount: 1 },
    { products: [{ productId: 'p1', quantity: 2 }] },
    { products: [{ productId: 'p1', quantity: '3' }] },
    { productCount: 'unknown' },
    { products: [{ quantity: 'unknown' }] },
    { products: [{ productId: 'p1' }] },
    { products: [{ quantity: '' }] },
    { products: [{ quantity: false }] },
    { products: { quantity: 1 } },
  ])('refuses occupied or unverifiable bins: %j', async (data) => {
    addBin('XQGA0101A', data);
    await expect(remove()).rejects.toThrow(/Bestand|prüf/);
    expect(writes).toHaveLength(0);
    expect(store.warehouseZones.XQ_GA).toBeDefined();
  });

  it('checks referenced children even if legacy zone metadata is missing', async () => {
    addBin('XQGA0101A', { childBinCodes: ['XQGA0101A01'] });
    store.warehouseBins.XQGA0101A01 = { products: [{ quantity: 1 }] };
    await expect(remove()).rejects.toThrow(/Bestand/);
    expect(writes).toHaveLength(0);
  });

  it('deletes a child only once if returned by both query and parent references', async () => {
    addBin('XQGA0101A', { childBinCodes: ['XQGA0101A01'] });
    addBin('XQGA0101A01', { parentBinCode: 'XQGA0101A', isContainer: true });
    expect((await remove()).deleted).toBe(2);
    expect(writes.filter(([op]) => op === 'delete')).toHaveLength(3);
  });

  it('rechecks stock added between preview and confirmation', async () => {
    addBin();
    await remove({ dryRun: true });
    store.warehouseBins.XQGA0101A.products.push({ quantity: 1 });
    await expect(remove()).rejects.toThrow(/Bestand/);
    expect(writes).toHaveLength(0);
  });

  it('rechecks stock on a transaction retry and never partially deletes', async () => {
    addBin();
    retryWith = () => { store.warehouseBins.XQGA0101A.productCount = 1; };
    await expect(remove()).rejects.toThrow(/Bestand/);
    expect(writes).toHaveLength(0);
    expect(store.warehouseZones.XQ_GA).toBeDefined();
  });

  it('preserves the entire zone when the commit fails', async () => {
    addBin();
    failCommit = true;
    await expect(remove()).rejects.toThrow('Commit failed');
    expect(store.warehouseZones.XQ_GA).toBeDefined();
    expect(store.warehouseBins.XQGA0101A).toBeDefined();
    expect(writes).toHaveLength(0);
  });

  it('is idempotent for an already deleted zone', async () => {
    await remove();
    writes.length = 0;
    expect(await remove()).toMatchObject({ zoneDeleted: false, deleted: 0 });
    expect(writes).toHaveLength(0);
  });

  it('rejects a foreign tenant zone and never adopts unscoped legacy zones', async () => {
    await expect(remove({ tenantId: 'other' })).rejects.toThrow(/Zone/);
    store.warehouseZones.XQ_GA.tenantId = 'other';
    await expect(remove()).rejects.toThrow(/Zone/);
    expect(writes).toHaveLength(0);
  });

  it('refuses a foreign bin inside an otherwise owned zone', async () => {
    addBin('XQGA0101A', { tenantId: 'other' });
    await expect(remove()).rejects.toThrow(/Zuordnung/);
    expect(writes).toHaveLength(0);
  });

  it('refuses an incorrectly linked child from another zone', async () => {
    addBin('XQGA0101A', { childBinCodes: ['SEG0101A'] });
    addBin('SEG0101A', { zone: 'S', etage: 'EG' });
    await expect(remove()).rejects.toThrow(/Zuordnung/);
    expect(writes).toHaveLength(0);
  });

  it('requires a tenant and valid zone/floor input', async () => {
    await expect(remove({ tenantId: '' })).rejects.toThrow(/Tenant/);
    await expect(deleteWarehouseZone('../X', 'GA', { tenantId: 'default' })).rejects.toThrow(/Zone/);
    expect(writes).toHaveLength(0);
  });

  it('supports an explicitly owned tenant zone and normalizes input', async () => {
    store.warehouseZones.XQ_GA.tenantId = 'tenant-2';
    addBin('XQGA0101A', { tenantId: 'tenant-2' });
    expect(await deleteWarehouseZone(' xq ', 'ga', { tenantId: 'tenant-2', dryRun: false })).toMatchObject({ deleted: 1, zoneDeleted: true });
    expect(Object.values(store.warehouseEvents)[0].tenantId).toBe('tenant-2');
  });

  it('includes newly created bins when the transaction retries', async () => {
    retryWith = () => addBin('XQGA0101A', { productCount: 2 });
    await expect(remove()).rejects.toThrow(/Bestand/);
    expect(writes).toHaveLength(0);
  });
});

describe('DELETE /api/warehouse/layouts/:zone/:etage', () => {
  it('previews by default and uses warehouse.configure', async () => {
    const res = await request(app).delete(endpoint).expect(200);
    expect(res.body.data.dryRun).toBe(true);
    expect(permissions).toContainEqual(['warehouse', 'configure']);
    expect(writes).toHaveLength(0);
  });
  it('dryRun wins over confirm', async () => {
    await request(app).delete(`${endpoint}?confirm=1&dryRun=1`).expect(200);
    expect(writes).toHaveLength(0);
  });
  it('deletes only with confirmation and preserves the actor', async () => {
    const res = await request(app).delete(`${endpoint}?confirm=1`).expect(200);
    expect(res.body.data.zoneDeleted).toBe(true);
    expect(Object.values(store.warehouseEvents)[0].actor.uid).toBe('test-user');
  });
  it('blocks stock and unauthorized users without mutations', async () => {
    addBin('XQGA0101A', { productCount: 1 });
    await request(app).delete(`${endpoint}?confirm=1`).expect(409);
    await request(app).delete(`${endpoint}?confirm=1`).set('x-deny', '1').expect(403);
    expect(writes).toHaveLength(0);
  });
  it('takes tenant from the authenticated user', async () => {
    await request(app).delete(`${endpoint}?confirm=1&tenantId=default`).set('x-tenant', 'other').expect(404);
    expect(writes).toHaveLength(0);
  });
});
