/**
 * Tests for Child-BIN (Container) functions: createChildBin, deleteChildBin, listChildBins, getBinByCode.
 *
 * Setup:
 *   1. Patch @google-cloud/firestore via _patchGcp
 *   2. Intercept Firestore constructor to capture warehouse.js's internal instance
 *   3. Patch lib/firestore.js
 *   4. Load warehouse.js
 */

// ─── 1. GCP mocks ──────────────────────────────────────────────────────────────
const { mockCol, mockQuery } = require('./api/_patchGcp');

// ─── 2. Capture the Firestore instance that warehouse.js will create ────────────
const fsPath = require.resolve('@google-cloud/firestore');
const fsExports = require.cache[fsPath].exports;
const OrigMockFirestore = fsExports.Firestore;
let warehouseFs = null;
function CapturingFirestore(...args) {
  const instance = OrigMockFirestore.call(this, ...args);
  warehouseFs = instance;
  return instance;
}
CapturingFirestore.Timestamp = OrigMockFirestore.Timestamp;
CapturingFirestore.FieldValue = OrigMockFirestore.FieldValue;
fsExports.Firestore = CapturingFirestore;

// ─── 3. Patch lib/firestore.js ──────────────────────────────────────────────────
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

// ─── 4. Load the module under test ──────────────────────────────────────────────
const {
  createChildBin,
  deleteChildBin,
  listChildBins,
  getBinByCode,
} = require('../lib/warehouse');

// ─── Helpers ────────────────────────────────────────────────────────────────────

function makeSnapshot(docs) {
  return {
    docs,
    empty: docs.length === 0,
    size: docs.length,
    forEach: (cb) => docs.forEach(cb),
  };
}

function makeDocSnap(id, data, exists = true) {
  return {
    exists,
    id,
    data: () => ({
      code: id,
      zone: 'S',
      etage: 'EG',
      gang: 1,
      regal: 1,
      ebene: 'E',
      productCount: 0,
      products: [],
      childBinCodes: [],
      createdAt: { toDate: () => new Date() },
      firstStoredAt: null,
      lastStoredAt: null,
      ...data,
    }),
  };
}

function mockTransaction(getResponses) {
  warehouseFs.runTransaction.mockImplementationOnce(async (fn) => {
    let callIndex = 0;
    const tx = {
      get: vi.fn(async () => {
        if (callIndex < getResponses.length) {
          return getResponses[callIndex++];
        }
        return { exists: false, data: () => ({}) };
      }),
      set: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
    return fn(tx);
  });
}

// ─── Tests: createChildBin ──────────────────────────────────────────────────────

describe('createChildBin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates child with correct code format (parent + 2-digit index)', async () => {
    mockTransaction([makeDocSnap('SEG0101E', { childBinCodes: [] })]);

    const result = await createChildBin('SEG0101E');
    expect(result.code).toBe('SEG0101E01');
    expect(result.parentBinCode).toBe('SEG0101E');
    expect(result.isContainer).toBe(true);
    expect(result.containerIndex).toBe(1);
  });

  it('finds next free index when 01 is already taken', async () => {
    mockTransaction([makeDocSnap('SEG0101E', { childBinCodes: ['SEG0101E01'] })]);

    const result = await createChildBin('SEG0101E');
    expect(result.code).toBe('SEG0101E02');
    expect(result.containerIndex).toBe(2);
  });

  it('throws error when parent does not exist', async () => {
    mockTransaction([{ exists: false, data: () => ({}) }]);

    await expect(createChildBin('NONEXISTENT')).rejects.toThrow('Parent-BIN nicht gefunden');
  });

  it('prevents creating child on a container BIN', async () => {
    mockTransaction([makeDocSnap('SEG0101E01', { isContainer: true, parentBinCode: 'SEG0101E' })]);

    await expect(createChildBin('SEG0101E01')).rejects.toThrow('keine weiteren Behälter');
  });
});

// ─── Tests: deleteChildBin ──────────────────────────────────────────────────────

describe('deleteChildBin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws error when child is not empty', async () => {
    mockTransaction([
      makeDocSnap('SEG0101E01', {
        isContainer: true,
        parentBinCode: 'SEG0101E',
        products: [{ productId: 'p1', quantity: 3 }],
      }),
    ]);

    await expect(deleteChildBin('SEG0101E01')).rejects.toThrow('nicht leer');
  });

  it('removes code from parent.childBinCodes on deletion', async () => {
    let capturedParentUpdate = null;

    warehouseFs.runTransaction.mockImplementationOnce(async (fn) => {
      let callIndex = 0;
      const responses = [
        makeDocSnap('SEG0101E01', {
          isContainer: true,
          parentBinCode: 'SEG0101E',
          products: [],
        }),
        makeDocSnap('SEG0101E', {
          childBinCodes: ['SEG0101E01', 'SEG0101E02'],
        }),
      ];
      const tx = {
        get: vi.fn(async () => responses[callIndex++] || { exists: false, data: () => ({}) }),
        set: vi.fn(),
        update: vi.fn((_ref, data) => { capturedParentUpdate = data; }),
        delete: vi.fn(),
      };
      return fn(tx);
    });

    const result = await deleteChildBin('SEG0101E01');
    expect(result.deleted).toBe(true);
    expect(result.parentBinCode).toBe('SEG0101E');
    expect(capturedParentUpdate.childBinCodes).toEqual(['SEG0101E02']);
  });
});

// ─── Tests: listChildBins ───────────────────────────────────────────────────────

describe('listChildBins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns only children of the given parent, sorted by containerIndex', async () => {
    const child1 = {
      id: 'SEG0101E02',
      data: () => ({
        code: 'SEG0101E02',
        parentBinCode: 'SEG0101E',
        isContainer: true,
        containerIndex: 2,
        zone: 'S', etage: 'EG', gang: 1, regal: 1, ebene: 'E',
        productCount: 0,
        products: [],
        createdAt: { toDate: () => new Date() },
        firstStoredAt: null,
        lastStoredAt: null,
      }),
    };
    const child2 = {
      id: 'SEG0101E01',
      data: () => ({
        code: 'SEG0101E01',
        parentBinCode: 'SEG0101E',
        isContainer: true,
        containerIndex: 1,
        zone: 'S', etage: 'EG', gang: 1, regal: 1, ebene: 'E',
        productCount: 5,
        products: [{ productId: 'p1', quantity: 5 }],
        createdAt: { toDate: () => new Date() },
        firstStoredAt: null,
        lastStoredAt: null,
      }),
    };

    // binsCollection.where('parentBinCode', '==', code) returns a query-like object
    const whereResult = {
      where: vi.fn().mockReturnThis(),
      get: vi.fn().mockResolvedValue(makeSnapshot([child1, child2])),
    };
    mockCol.where.mockReturnValueOnce(whereResult);

    const result = await listChildBins('SEG0101E');
    expect(result).toHaveLength(2);
    // Sorted by containerIndex
    expect(result[0].code).toBe('SEG0101E01');
    expect(result[0].containerIndex).toBe(1);
    expect(result[0].productCount).toBe(5);
    expect(result[1].code).toBe('SEG0101E02');
    expect(result[1].containerIndex).toBe(2);
  });
});

// ─── Tests: getBinByCode with children ──────────────────────────────────────────

describe('getBinByCode — parent with children', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes children array and childrenProductCount in response', async () => {
    const parentData = {
      code: 'SEG0101E',
      zone: 'S', etage: 'EG', gang: 1, regal: 1, ebene: 'E',
      productCount: 0,
      products: [],
      childBinCodes: ['SEG0101E01'],
      createdAt: { toDate: () => new Date() },
      firstStoredAt: null,
      lastStoredAt: null,
    };

    const childData = {
      code: 'SEG0101E01',
      containerIndex: 1,
      parentBinCode: 'SEG0101E',
      isContainer: true,
      productCount: 5,
      products: [{ productId: 'p1', quantity: 5 }],
      createdAt: { toDate: () => new Date() },
      firstStoredAt: null,
      lastStoredAt: null,
    };

    // binsCollection.doc(binCode).get() returns parent
    mockCol.doc.mockReturnValueOnce({
      get: vi.fn().mockResolvedValue({ exists: true, id: 'SEG0101E', data: () => parentData }),
    });

    // binsCollection.where('parentBinCode', '==', code).get() returns children
    const whereResult = {
      where: vi.fn().mockReturnThis(),
      get: vi.fn().mockResolvedValue(makeSnapshot([
        { id: 'SEG0101E01', data: () => childData },
      ])),
    };
    mockCol.where.mockReturnValueOnce(whereResult);

    const result = await getBinByCode('SEG0101E');
    expect(result).not.toBeNull();
    expect(result.children).toHaveLength(1);
    expect(result.children[0].code).toBe('SEG0101E01');
    expect(result.children[0].productCount).toBe(5);
    expect(result.childrenProductCount).toBe(5);
  });
});
