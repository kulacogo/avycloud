const { mockCol, mockQuery, mockDoc } = require('./api/_patchGcp');
const firestorePath = require.resolve('../lib/firestore');
require.cache[firestorePath] = {
  id: firestorePath, filename: firestorePath, loaded: true,
  exports: { getProduct: vi.fn(), adjustPendingIntakeQuantity: vi.fn() },
};
const { listWarehouseZones } = require('../lib/warehouse');
const doc = (id, data) => ({ id, data: () => data, get: (key) => data[key] });
const snapshot = (docs) => ({ docs, size: docs.length, empty: docs.length === 0 });
const zone = (data = {}) => doc('S_EG', { zone: 'S', etage: 'EG', gangs: [5], regale: [1], ebenen: ['A'], binCount: 1, ...data });
const bin = (id, data = {}) => doc(id, { gang: 1, regal: 1, ebene: 'A', productCount: 0, products: [], ...data });

beforeEach(() => {
  vi.clearAllMocks();
  mockCol.get.mockResolvedValue(snapshot([zone()]));
  mockQuery.get.mockResolvedValue(snapshot([]));
});
afterEach(() => {
  // Loading a summary must never repair/migrate data or alter stock.
  expect(mockDoc.set).not.toHaveBeenCalled();
  expect(mockDoc.update).not.toHaveBeenCalled();
  expect(mockDoc.delete).not.toHaveBeenCalled();
  expect(mockCol.add).not.toHaveBeenCalled();
});

it('reproduces S/EG: ignores last-created one-BIN metadata and counts six actual aisles', async () => {
  const bins = [];
  for (let gang = 1; gang <= 6; gang++) {
    for (let regal = 1; regal <= 2; regal++) {
      for (const ebene of 'ABCDEFG') bins.push(bin(`S-${gang}-${regal}-${ebene}`, { gang, regal, ebene }));
    }
  }
  for (let i = 1; i <= 36; i++) bins.push(bin(`child-${i}`, { isContainer: true, parentBinCode: 'S-1-1-A' }));
  mockQuery.get.mockResolvedValueOnce(snapshot(bins));
  expect(await listWarehouseZones()).toEqual([expect.objectContaining({
    id: 'S_EG', zone: 'S', etage: 'EG', gangs: [1, 2, 3, 4, 5, 6], regale: [1, 2],
    ebenen: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], binCount: 120,
    rootBinCount: 84, containerCount: 36, shelfCount: 12,
  })]);
  expect(mockCol.get).toHaveBeenCalledTimes(1);
  expect(mockQuery.get).toHaveBeenCalledTimes(1);
});

it('reports an actually empty zone as empty even when every stored summary field is stale', async () => {
  mockCol.get.mockResolvedValueOnce(snapshot([zone({ binCount: 99, totalProducts: 400 })]));
  expect(await listWarehouseZones()).toEqual([expect.objectContaining({
    binCount: 0, rootBinCount: 0, containerCount: 0, shelfCount: 0,
    gangs: [], regale: [], ebenen: [], totalProducts: 0,
  })]);
});

it('normalizes and sorts aisle/shelf numbers and de-duplicates levels', async () => {
  mockQuery.get.mockResolvedValueOnce(snapshot([
    bin('a', { gang: 10, regal: 12, ebene: ' g ' }),
    bin('b', { gang: '2', regal: '3', ebene: 'a' }),
    bin('c', { gang: 2, regal: 3, ebene: 'A' }),
    bin('d', { gang: null, regal: undefined, ebene: null }),
  ]));
  expect((await listWarehouseZones())[0]).toMatchObject({ gangs: [2, 10], regale: [3, 12], ebenen: ['A', 'G'], shelfCount: 2 });
});

it('counts units from actual product entries instead of stale or string counters', async () => {
  mockQuery.get.mockResolvedValueOnce(snapshot([
    bin('a', { productCount: 900, products: [{ productId: 'same-sku', quantity: 2 }, { quantity: '3' }] }),
    bin('b', { productCount: '700', products: [{ productId: 'same-sku', quantity: 4 }] }),
    bin('c', { productCount: 500, products: [] }),
  ]));
  expect((await listWarehouseZones())[0].totalProducts).toBe(9);
});

it('retains legacy quantity counters only when product entries are absent', async () => {
  mockQuery.get.mockResolvedValueOnce(snapshot([
    doc('a', { gang: 1, regal: 1, ebene: 'A', productCount: '7' }),
    doc('b', { gang: 1, regal: 1, ebene: 'B', productCount: 2 }),
  ]));
  expect((await listWarehouseZones())[0].totalProducts).toBe(9);
});

it('distinguishes root locations from containers without counting child shelves twice', async () => {
  mockQuery.get.mockResolvedValueOnce(snapshot([
    bin('root', { productCount: 5, products: [{ quantity: 5 }] }),
    bin('child1', { parentBinCode: 'root', products: [{ quantity: 2 }] }),
    bin('child2', { isContainer: true, products: [{ quantity: 3 }] }),
  ]));
  expect((await listWarehouseZones())[0]).toMatchObject({ binCount: 3, rootBinCount: 1, containerCount: 2, shelfCount: 1, totalProducts: 10 });
});

it('keeps zones and floors separate using their existing slice queries', async () => {
  mockCol.get.mockResolvedValueOnce(snapshot([zone(), doc('S_GA', { zone: 'S', etage: 'GA' })]));
  mockQuery.get.mockResolvedValueOnce(snapshot([bin('eg', { gang: 6 })])).mockResolvedValueOnce(snapshot([]));
  const result = await listWarehouseZones();
  expect(result[0]).toMatchObject({ etage: 'EG', binCount: 1, gangs: [6] });
  expect(result[1]).toMatchObject({ etage: 'GA', binCount: 0, gangs: [] });
  expect(mockQuery.where).toHaveBeenCalledWith('etage', '==', 'EG');
  expect(mockQuery.where).toHaveBeenCalledWith('etage', '==', 'GA');
});

it('fails a read instead of displaying an invented empty zone', async () => {
  mockQuery.get.mockRejectedValueOnce(new Error('Read failed'));
  await expect(listWarehouseZones()).rejects.toThrow('Read failed');
});
