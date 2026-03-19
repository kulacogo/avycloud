/**
 * Unit tests for services/bulk-update.js
 *
 * Uses require.cache patching to mock product-store (CJS-compatible).
 * Vitest globals (describe, it, expect, vi) are available via vitest.config globals: true.
 */

const path = require('path');

// ─── Patch product-store in require.cache BEFORE importing bulk-update ──
const productStorePath = require.resolve('../lib/product-store');
const mockGetProductV2 = vi.fn();
const mockSaveProductV2 = vi.fn().mockResolvedValue({});
require.cache[productStorePath] = {
  id: productStorePath,
  filename: productStorePath,
  loaded: true,
  exports: {
    getProductV2: mockGetProductV2,
    saveProductV2: mockSaveProductV2,
    getCollection: () => 'products_v2',
    COLLECTION: 'products',
    V2_COLLECTION: 'products_v2',
    USE_V2: true,
  },
  children: [],
  paths: [],
};

const { bulkUpdateProducts, getNestedValue, setNestedValue } = require('./bulk-update');

// Alias for readability
const getProductV2 = mockGetProductV2;
const saveProductV2 = mockSaveProductV2;

// ─── Helper: create a fake product ──────────────────────────────────────
function makeProduct(id, overrides = {}) {
  return {
    id,
    identification: { name: `Product ${id}`, brand: 'TestBrand', category: 'Elektronik', sku: `SKU-${id}`, barcodes: [] },
    details: {
      pricing: { sellPrice: 19.99, buyPrice: 10.00, lowest_price: { amount: 15.00 } },
      attributes: { condition: 'Neu' },
      images: [],
    },
    ops: { sync_status: 'draft' },
    ...overrides,
  };
}

describe('bulkUpdateProducts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should update a single field on multiple products', async () => {
    const p1 = makeProduct('p1');
    const p2 = makeProduct('p2');
    getProductV2.mockResolvedValueOnce(p1).mockResolvedValueOnce(p2);

    const result = await bulkUpdateProducts({
      productIds: ['p1', 'p2'],
      updates: [{ field: 'details.pricing.sellPrice', value: 29.99 }],
    });

    expect(result.updated).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(saveProductV2).toHaveBeenCalledTimes(2);
    // Verify mode: 'manual' is passed
    expect(saveProductV2).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p1' }),
      expect.objectContaining({ mode: 'manual' })
    );
  });

  it('should return diff in dryRun mode without writing', async () => {
    const p1 = makeProduct('p1');
    getProductV2.mockResolvedValueOnce(p1);

    const result = await bulkUpdateProducts({
      productIds: ['p1'],
      updates: [{ field: 'details.pricing.sellPrice', value: 29.99 }],
      dryRun: true,
    });

    expect(result.updated).toBe(1);
    expect(result.diff).toHaveLength(1);
    expect(result.diff[0].status).toBe('ready');
    expect(result.diff[0].changes).toEqual([
      { field: 'details.pricing.sellPrice', oldValue: 19.99, newValue: 29.99 },
    ]);
    expect(saveProductV2).not.toHaveBeenCalled();
  });

  it('should skip products with no actual change', async () => {
    const p1 = makeProduct('p1');
    getProductV2.mockResolvedValueOnce(p1);

    const result = await bulkUpdateProducts({
      productIds: ['p1'],
      updates: [{ field: 'details.pricing.sellPrice', value: 19.99 }],
      dryRun: true,
    });

    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.diff[0].status).toBe('skipped');
  });

  it('should reject invalid field paths', async () => {
    await expect(
      bulkUpdateProducts({
        productIds: ['p1'],
        updates: [{ field: 'some.invalid.field', value: 'x' }],
      })
    ).rejects.toThrow('Unbekanntes Feld: some.invalid.field');
  });

  it('should reject more than 500 products', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `p${i}`);
    await expect(
      bulkUpdateProducts({
        productIds: ids,
        updates: [{ field: 'details.pricing.sellPrice', value: 10 }],
      })
    ).rejects.toThrow('1-500');
  });

  it('should reject empty productIds', async () => {
    await expect(
      bulkUpdateProducts({
        productIds: [],
        updates: [{ field: 'details.pricing.sellPrice', value: 10 }],
      })
    ).rejects.toThrow('1-500');
  });

  it('should handle partial failures gracefully', async () => {
    const p1 = makeProduct('p1');
    getProductV2.mockResolvedValueOnce(p1).mockResolvedValueOnce(null);

    const result = await bulkUpdateProducts({
      productIds: ['p1', 'missing'],
      updates: [{ field: 'details.pricing.sellPrice', value: 29.99 }],
    });

    expect(result.updated).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].id).toBe('missing');
    expect(result.errors[0].reason).toBe('Product not found');
  });

  it('should call saveProductV2 with mode manual', async () => {
    const p1 = makeProduct('p1');
    getProductV2.mockResolvedValueOnce(p1);

    await bulkUpdateProducts({
      productIds: ['p1'],
      updates: [{ field: 'identification.name', value: 'New Name' }],
    });

    expect(saveProductV2).toHaveBeenCalledWith(
      expect.objectContaining({
        identification: expect.objectContaining({ name: 'New Name' }),
      }),
      { mode: 'manual' }
    );
  });

  it('should deduplicate product IDs', async () => {
    const p1 = makeProduct('p1');
    getProductV2.mockResolvedValue(p1);

    const result = await bulkUpdateProducts({
      productIds: ['p1', 'p1', 'p1'],
      updates: [{ field: 'details.pricing.sellPrice', value: 29.99 }],
    });

    expect(getProductV2).toHaveBeenCalledTimes(1);
    expect(result.updated).toBe(1);
  });
});

describe('getNestedValue / setNestedValue', () => {
  it('should get nested values by dot path', () => {
    const obj = { a: { b: { c: 42 } } };
    expect(getNestedValue(obj, 'a.b.c')).toBe(42);
    expect(getNestedValue(obj, 'a.b')).toEqual({ c: 42 });
    expect(getNestedValue(obj, 'x.y.z')).toBeUndefined();
  });

  it('should set nested values by dot path', () => {
    const obj = { a: { b: {} } };
    setNestedValue(obj, 'a.b.c', 99);
    expect(obj.a.b.c).toBe(99);
  });

  it('should create intermediate objects', () => {
    const obj = {};
    setNestedValue(obj, 'x.y.z', 'hello');
    expect(obj.x.y.z).toBe('hello');
  });
});
