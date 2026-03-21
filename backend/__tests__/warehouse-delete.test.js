/**
 * Tests for deleteWarehouseBinsByFilter — nonEmpty filter logic (BUG-078).
 *
 * Setup:
 *   1. Patch @google-cloud/firestore via _patchGcp
 *   2. Patch lib/firestore.js (warehouse.js imports getProduct, adjustPendingIntakeQuantity)
 *   3. Require warehouse.js (gets mocked Firestore)
 */

// ─── 1. GCP mocks ──────────────────────────────────────────────────────────────
const { mockQuery, mockCol } = require('./api/_patchGcp');

// ─── 2. Patch lib/firestore.js (minimal stub — warehouse.js only uses 2 exports)
const firestorePath = require.resolve('../lib/firestore.js');
require.cache[firestorePath] = {
  id: firestorePath,
  filename: firestorePath,
  loaded: true,
  exports: {
    getProduct: vi.fn().mockResolvedValue(null),
    adjustPendingIntakeQuantity: vi.fn().mockResolvedValue(),
  },
  children: [],
  paths: [],
};

// ─── 3. Load the module under test ──────────────────────────────────────────────
const { deleteWarehouseBinsByFilter } = require('../lib/warehouse');

// ─── Helpers ────────────────────────────────────────────────────────────────────
function makeBinDoc(id, { productCount = 0, products = [] } = {}) {
  return { id, data: () => ({ productCount, products }) };
}

function makeSnapshot(docs) {
  return {
    docs,
    empty: docs.length === 0,
    size: docs.length,
    forEach: (cb) => docs.forEach(cb),
  };
}

const FILTER = { zone: 'XQ', etage: 'GA', gang: 1 };

// ─── Tests ──────────────────────────────────────────────────────────────────────
describe('deleteWarehouseBinsByFilter — nonEmpty filter (BUG-078)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows deletion when all products have quantity 0', async () => {
    const bins = [
      makeBinDoc('XQGA0101A', {
        productCount: 0,
        products: [
          { productId: 'prod1', quantity: 0 },
          { productId: 'prod2', quantity: 0 },
        ],
      }),
    ];

    // First .get() = deleteWarehouseBinsByFilter query
    // Subsequent .get() = recomputeWarehouseZoneLayout (empty is fine)
    mockQuery.get.mockResolvedValueOnce(makeSnapshot(bins));

    const result = await deleteWarehouseBinsByFilter(FILTER);
    expect(result.deleted).toBe(1);
    expect(result.binCodes).toContain('XQGA0101A');
  });

  it('blocks deletion when at least one product has quantity > 0', async () => {
    const bins = [
      makeBinDoc('XQGA0101A', {
        productCount: 0,
        products: [
          { productId: 'prod1', quantity: 0 },
          { productId: 'prod2', quantity: 5 },
        ],
      }),
    ];

    mockQuery.get.mockResolvedValueOnce(makeSnapshot(bins));

    await expect(deleteWarehouseBinsByFilter(FILTER)).rejects.toThrow(
      'Kann nicht löschen'
    );
  });

  it('blocks deletion when productCount > 0 even with empty products array', async () => {
    const bins = [
      makeBinDoc('XQGA0101A', { productCount: 3, products: [] }),
    ];

    mockQuery.get.mockResolvedValueOnce(makeSnapshot(bins));

    await expect(deleteWarehouseBinsByFilter(FILTER)).rejects.toThrow(
      'Kann nicht löschen'
    );
  });

  it('allows deletion when products array is absent and productCount is 0', async () => {
    const bins = [makeBinDoc('XQGA0101A', { productCount: 0 })];

    mockQuery.get.mockResolvedValueOnce(makeSnapshot(bins));

    const result = await deleteWarehouseBinsByFilter(FILTER);
    expect(result.deleted).toBe(1);
  });
});
