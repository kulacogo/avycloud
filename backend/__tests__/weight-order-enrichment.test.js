// backend/__tests__/weight-order-enrichment.test.js

// ─── Patch GCP before anything else ────────────────────────────────────────
require('./api/_patchGcp');

// ─── Stub firestore with controllable query mock ───────────────────────────
const mockGet = vi.fn();
const mockLimit = vi.fn(() => ({ get: mockGet }));
const mockWhere = vi.fn(() => ({ where: mockWhere, limit: mockLimit }));
const mockCollection = vi.fn(() => ({ where: mockWhere }));
const mockFirestore = { collection: mockCollection };

// Patch product-store's dependency on firestore
const path = require('path');
const firestorePath = require.resolve('../lib/firestore');
require.cache[firestorePath] = {
  id: firestorePath, filename: firestorePath, loaded: true,
  exports: {
    firestore: mockFirestore,
    saveProduct: vi.fn(),
    PRODUCTS_COLLECTION: 'products',
  },
  children: [], paths: [],
};

// Stub product-canonical (required by product-store)
const canonPath = require.resolve('../lib/product-canonical');
require.cache[canonPath] = {
  id: canonPath, filename: canonPath, loaded: true,
  exports: { normalizeProduct: vi.fn(p => p), validateCanonical: vi.fn(() => ({ valid: true })) },
  children: [], paths: [],
};

// NOW load product-store
const { getProductWeightBySku } = require('../lib/product-store');

describe('getProductWeightBySku', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ empty: true, docs: [] });
  });

  it('returns weight when product found by SKU', async () => {
    mockGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ id: 'p1', data: () => ({ details: { weight: 3.6 } }) }],
    });

    const result = await getProductWeightBySku('SKU-123', 'EAN-456');
    expect(result).toBe(3.6);
    expect(mockWhere).toHaveBeenCalledWith('identification.sku', '==', 'SKU-123');
  });

  it('falls back to EAN when SKU not found', async () => {
    mockGet.mockResolvedValueOnce({ empty: true, docs: [] });
    mockGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ id: 'p2', data: () => ({ details: { weight: 1.2 } }) }],
    });

    const result = await getProductWeightBySku('SKU-MISSING', 'EAN-456');
    expect(result).toBe(1.2);
  });

  it('returns null when no product found', async () => {
    const result = await getProductWeightBySku('SKU-999', null);
    expect(result).toBeNull();
  });

  it('returns null when product has no weight', async () => {
    mockGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ id: 'p3', data: () => ({ details: {} }) }],
    });

    const result = await getProductWeightBySku('SKU-123', null);
    expect(result).toBeNull();
  });

  it('returns null when both sku and ean are empty', async () => {
    const result = await getProductWeightBySku(null, null);
    expect(result).toBeNull();
  });

  it('tries details.attributes.weight as fallback', async () => {
    mockGet.mockResolvedValueOnce({
      empty: false,
      docs: [{ id: 'p4', data: () => ({ details: { attributes: { weight: 2.5 } } }) }],
    });

    const result = await getProductWeightBySku('SKU-123', null);
    expect(result).toBe(2.5);
  });
});
