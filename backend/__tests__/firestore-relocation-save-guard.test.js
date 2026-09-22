const store = new Map();
let beforeFinalWrite;
let retryFinalWrite;
let transactionWrites;
const snapshot = (ref) => {
  const data = store.get(ref.path);
  return { id: ref.id, exists: data !== undefined, data: () => structuredClone(data) };
};
const reference = (collection, id) => ({
  id, path: `${collection}/${id}`,
  get: async function () { return snapshot(this); },
  set: async function (data) {
    // Model a relocation that commits while a slow content save is preparing.
    if (collection === 'products_v2' && beforeFinalWrite) { beforeFinalWrite(); beforeFinalWrite = null; }
    store.set(this.path, structuredClone(data));
  },
  update: async () => {}, delete: async () => {},
});
const emptyQuery = () => ({
  where: emptyQuery, orderBy: emptyQuery, limit: emptyQuery, select: emptyQuery,
  get: async () => ({ docs: [], empty: true, size: 0, forEach: () => {} }),
});
const db = {
  collection: name => ({ ...emptyQuery(), doc: id => reference(name, id || 'auto'), add: async () => reference(name, 'auto') }),
  runTransaction: async function (callback) {
    const writes = [];
    const tx = {
      get: async ref => {
        if (writes.length) throw new Error('Read after write');
        if (ref.path?.startsWith('products_v2/') && beforeFinalWrite) { beforeFinalWrite(); beforeFinalWrite = null; }
        return ref.get();
      },
      set: (ref, data) => writes.push([ref, structuredClone(data)]), update: () => {}, delete: () => {},
    };
    await callback(tx);
    if (writes.some(([ref]) => ref.path.startsWith('products_v2/')) && retryFinalWrite) {
      retryFinalWrite(); retryFinalWrite = null;
      return this.runTransaction(callback);
    }
    for (const [ref, data] of writes) {
      if (ref.path.startsWith('products_v2/')) transactionWrites++;
      store.set(ref.path, data);
    }
  },
  batch: () => ({ set() {}, update() {}, delete() {}, commit: async () => [] }),
};
function Firestore() { return db; }
function FieldValue() {}
Object.assign(FieldValue, { serverTimestamp: () => null, increment: n => n, delete: () => null, arrayUnion: (...v) => v, arrayRemove: (...v) => v });
function patch(module, exports) {
  const id = require.resolve(module);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
patch('@google-cloud/firestore', { Firestore, FieldValue });
process.env.USE_PRODUCTS_V2 = 'true';
process.env.TITLE_POLICY_DISABLED = 'true';
process.env.CHAT_TITLE_MIN_FILL = 'off';
process.env.GPSR_REGISTRY_ENFORCE = 'false';
const { saveProduct } = require('../lib/firestore');

const base = () => ({
  id: 'p1', tenantId: 'default', identification: { name: 'Original product title', sku: 'SKU-1234567890' },
  details: { identifiers: { sku: 'SKU-1234567890' }, attributes: {} },
  inventory: { quantity: 3 }, storage: { binCode: 'XEG0101A', quantity: 3 },
  storageBins: [{ code: 'XEG0101A', quantity: 3 }], ops: { unrelated: 'keep' },
});
const markRelocated = (unassigned = 3) => {
  const current = store.get('products_v2/p1');
  current.storage = unassigned === 3 ? null : { binCode: 'SEG0101A', quantity: 3 - unassigned };
  current.storageBins = unassigned === 3 ? [] : [{ code: 'SEG0101A', quantity: 3 - unassigned }];
  current.ops.relocation = { unassignedQuantity: unassigned, operationId: 'move-x' };
};
const save = options => saveProduct({ ...base(), identification: { ...base().identification, name: 'Changed content title' } }, { source: 'ui', skipTitlePolicy: true, ...options });
beforeEach(() => {
  store.clear(); store.set('products_v2/p1', base());
  beforeFinalWrite = null; retryFinalWrite = null; transactionWrites = 0;
});

it.each([false, true])('retains relocation committed after initial read, allowWarehouseFields=%s', async allowWarehouseFields => {
  beforeFinalWrite = () => markRelocated();
  await save({ allowWarehouseFields });
  const actual = store.get('products_v2/p1');
  expect(actual.identification.name).toBe('Changed content title');
  expect(actual.storage).toBeNull();
  expect(actual.storageBins).toEqual([]);
  expect(actual.inventory.quantity).toBe(3);
  expect(actual.ops.relocation).toEqual({ unassignedQuantity: 3, operationId: 'move-x' });
  expect(actual.ops.unrelated).toBe('keep');
  expect(transactionWrites).toBe(1);
});

it('preserves the latest restow quantity and location when the final transaction retries', async () => {
  markRelocated();
  retryFinalWrite = () => markRelocated(1);
  await save();
  const actual = store.get('products_v2/p1');
  expect(actual.ops.relocation.unassignedQuantity).toBe(1);
  expect(actual.storageBins).toEqual([{ code: 'SEG0101A', quantity: 2 }]);
  expect(actual.inventory.quantity).toBe(3);
});

it('preserves a concurrent stock decrement along with the relocation marker', async () => {
  beforeFinalWrite = () => {
    markRelocated(2);
    const current = store.get('products_v2/p1');
    current.inventory.quantity = 2;
    current.storage = null; current.storageBins = [];
  };
  await save({ allowWarehouseFields: true });
  const actual = store.get('products_v2/p1');
  expect(actual.inventory.quantity).toBe(2);
  expect(actual.ops.relocation.unassignedQuantity).toBe(2);
  expect(actual.storage).toBeNull();
});

it('retains existing explicit warehouse-field behavior for products without relocation', async () => {
  await saveProduct({ ...base(), inventory: { quantity: 8 } }, { source: 'ui', skipTitlePolicy: true, allowWarehouseFields: true });
  expect(store.get('products_v2/p1').inventory.quantity).toBe(8);
  expect(store.get('products_v2/p1').ops.relocation).toBeUndefined();
});

it('continues to preserve fresh stock during ordinary non-warehouse content saves', async () => {
  beforeFinalWrite = () => { store.get('products_v2/p1').inventory.quantity = 2; };
  await save();
  expect(store.get('products_v2/p1').inventory.quantity).toBe(2);
});
