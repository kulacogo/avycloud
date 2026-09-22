const firestorePath = require.resolve('../lib/firestore');
const storePath = require.resolve('../lib/product-store');
const canonicalPath = require.resolve('../lib/product-canonical');
const saveProduct = vi.fn();
const firestore = { collection: vi.fn(() => { throw new Error('Unexpected Firestore read'); }) };
const canonical = { normalizeProduct: vi.fn(), validateCanonical: vi.fn() };
const firestoreExports = { firestore, saveProduct, PRODUCTS_COLLECTION: 'products_v2' };
for (const [id, exports] of [[firestorePath, firestoreExports], [canonicalPath, canonical]]) {
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
delete require.cache[storePath];
const { saveProductV2 } = require(storePath);

let tx;
let snapshot;
let current;
const patch = () => ({ storage: null, storageBins: [], 'ops.relocation': { unassignedQuantity: 3, operationId: 'move-X' } });
const save = (options = {}, product = { id: 'p1' }) => saveProductV2(product, {
  warehousePatch: patch(), transaction: tx, productSnapshot: snapshot, tenantId: 'default', ...options,
});

beforeEach(() => {
  vi.clearAllMocks();
  firestoreExports.PRODUCTS_COLLECTION = 'products_v2';
  tx = { get: vi.fn(), set: vi.fn(), update: vi.fn() };
  current = {
    id: 'p1', tenantId: 'default', inventory: { quantity: 3 },
    identification: { name: 'Existing item' }, storage: { binCode: 'XEG0101A' },
    storageBins: [{ code: 'XEG0101A', quantity: 3 }], ops: { ebay: { itemId: 'keep' }, data_quality: 'keep' },
  };
  snapshot = { id: 'p1', exists: true, ref: { id: 'p1', path: 'products_v2/p1', parent: { id: 'products_v2', path: 'products_v2' } }, data: () => current };
});
afterEach(() => {
  expect(tx.get).not.toHaveBeenCalled();
  expect(tx.set).not.toHaveBeenCalled();
  expect(firestore.collection).not.toHaveBeenCalled();
  expect(saveProduct).not.toHaveBeenCalled();
  expect(canonical.normalizeProduct).not.toHaveBeenCalled();
  expect(canonical.validateCanonical).not.toHaveBeenCalled();
});

it('updates only warehouse fields on an existing transaction snapshot, retaining inventory and unrelated ops', async () => {
  const result = await save();
  expect(tx.update).toHaveBeenCalledExactlyOnceWith(snapshot.ref, patch());
  expect(result).toMatchObject({ id: 'p1', inventory: { quantity: 3 }, storage: null, storageBins: [], ops: { ebay: { itemId: 'keep' }, data_quality: 'keep', relocation: patch()['ops.relocation'] } });
  expect(current.storage.binCode).toBe('XEG0101A');
  expect(current.ops.relocation).toBeUndefined();
});

it('permits legacy unscoped products only for the default tenant', async () => {
  delete current.tenantId;
  await save();
  expect(tx.update).toHaveBeenCalledOnce();
  tx.update.mockClear();
  await expect(save({ tenantId: 'foreign' })).rejects.toThrow(/tenant/i);
  expect(tx.update).not.toHaveBeenCalled();
});

it('permits a matching explicit tenant', async () => {
  current.tenantId = 'tenant2';
  await save({ tenantId: 'tenant2' });
  expect(tx.update).toHaveBeenCalledOnce();
});

it.each([
  { 'inventory.quantity': 0 }, { inventory: { quantity: 0 } }, { ops: { relocation: {} } },
  { 'ops.ebay': {} }, { identification: { name: 'changed' } }, { tenantId: 'other' },
  { 'storage.binCode': 'NEW' }, {}, null, [],
  { storage: undefined }, { storage: 'X' }, { storageBins: null }, { storageBins: [null] },
  { 'ops.relocation': 'bad' },
])('rejects invalid or out-of-scope warehousePatch %j', async (warehousePatch) => {
  await expect(save({ warehousePatch })).rejects.toThrow(/warehousePatch/);
  expect(tx.update).not.toHaveBeenCalled();
});

it.each([undefined, null, '', ' ', 7, 'other'])('rejects invalid/mismatched tenant %j', async (tenantId) => {
  await expect(save({ tenantId })).rejects.toThrow(/tenant/i);
  expect(tx.update).not.toHaveBeenCalled();
});

it.each([undefined, null, {}, { update: 'invalid' }])('requires a transaction with update %j', async (transaction) => {
  await expect(save({ transaction })).rejects.toThrow(/transaction/);
  expect(tx.update).not.toHaveBeenCalled();
});

it.each([undefined, null, { exists: false }, { exists: true }])('requires an existing complete snapshot %j', async (productSnapshot) => {
  await expect(save({ productSnapshot })).rejects.toThrow(/snapshot|existing/i);
  expect(tx.update).not.toHaveBeenCalled();
});

it.each([{}, { id: '' }, { id: 'p2' }, { id: 'p1', inventory: { quantity: 0 } }])('rejects missing/mismatched id or extra product data %j', async (product) => {
  await expect(save({}, product)).rejects.toThrow(/id|product/i);
  expect(tx.update).not.toHaveBeenCalled();
});

it('rejects snapshots from another collection or nested path', async () => {
  snapshot.ref.path = 'products/p1';
  await expect(save()).rejects.toThrow(/products_v2|collection/);
  snapshot.ref.path = 'tenants/default/products_v2/p1';
  await expect(save()).rejects.toThrow(/products_v2|collection/);
  expect(tx.update).not.toHaveBeenCalled();
});

it('rejects legacy collection configuration before any writes', async () => {
  firestoreExports.PRODUCTS_COLLECTION = 'products';
  await expect(save()).rejects.toThrow(/products_v2|collection/);
  expect(tx.update).not.toHaveBeenCalled();
});

it('rejects a stored id inconsistent with the document id', async () => {
  current.id = 'other';
  await expect(save()).rejects.toThrow(/id/);
  expect(tx.update).not.toHaveBeenCalled();
});

it('propagates transaction update failure without trying another save path', async () => {
  tx.update.mockImplementationOnce(() => { throw new Error('transaction failed'); });
  await expect(save()).rejects.toThrow('transaction failed');
  expect(tx.update).toHaveBeenCalledOnce();
});
