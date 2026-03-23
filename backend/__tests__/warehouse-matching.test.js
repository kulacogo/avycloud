/**
 * Tests for buildProductKeySet() and binEntryMatchesKeySet() — BUG-083.
 *
 * These are pure functions that don't need Firestore mocking.
 */

// ─── 1. GCP mocks (required because warehouse.js instantiates Firestore on load)
require('./api/_patchGcp');

// ─── 2. Patch lib/firestore.js (warehouse.js imports getProduct, adjustPendingIntakeQuantity)
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

// ─── 3. Load module under test ─────────────────────────────────────────────────
const { buildProductKeySet, binEntryMatchesKeySet, normalizeKey } = require('../lib/warehouse');

// ─── Tests: buildProductKeySet ─────────────────────────────────────────────────
describe('buildProductKeySet', () => {
  it('builds keySet from a simple productId string', () => {
    const keySet = buildProductKeySet('0313030022097');
    expect(keySet.has('0313030022097')).toBe(true);
  });

  it('builds keySet from SKU string with prefix variants', () => {
    const keySet = buildProductKeySet('SKU-7926913408');
    expect(keySet.has('sku-7926913408')).toBe(true);
    expect(keySet.has('7926913408')).toBe(true);
  });

  it('builds keySet from product data object with identification.sku', () => {
    const productData = {
      id: '0313030022097',
      identification: {
        sku: 'SKU-7926913408',
        barcodes: ['0313030022097', '313030022097'],
      },
      details: {
        identifiers: {
          sku: 'SKU-7926913408',
          ean: '0313030022097',
          gtin: '313030022097',
        },
      },
    };
    const keySet = buildProductKeySet(productData);

    // docId / data.id
    expect(keySet.has('0313030022097')).toBe(true);
    // SKU variants
    expect(keySet.has('sku-7926913408')).toBe(true);
    expect(keySet.has('7926913408')).toBe(true);
    // EAN/GTIN
    expect(keySet.has('313030022097')).toBe(true);
    // Barcodes
    expect(keySet.has('0313030022097')).toBe(true);
  });

  it('handles product data with only identification.sku (no details)', () => {
    const productData = {
      identification: { sku: 'SKU-1234567890' },
    };
    const keySet = buildProductKeySet(productData);
    expect(keySet.has('sku-1234567890')).toBe(true);
    expect(keySet.has('1234567890')).toBe(true);
  });

  it('handles null/undefined gracefully', () => {
    expect(buildProductKeySet(null).size).toBe(0);
    expect(buildProductKeySet(undefined).size).toBe(0);
    expect(buildProductKeySet('').size).toBe(0);
  });

  it('handles product data with empty barcodes array', () => {
    const productData = {
      identification: { barcodes: [] },
      details: { identifiers: {} },
    };
    const keySet = buildProductKeySet(productData);
    // Should not throw, and should be empty or near-empty
    expect(keySet).toBeInstanceOf(Set);
  });
});

// ─── Tests: binEntryMatchesKeySet ──────────────────────────────────────────────
describe('binEntryMatchesKeySet', () => {
  it('matches by exact productId', () => {
    const keySet = buildProductKeySet('0313030022097');
    const entry = { productId: '0313030022097', sku: 'SKU-7926913408', quantity: 1 };
    expect(binEntryMatchesKeySet(entry, keySet)).toBe(true);
  });

  it('matches by SKU when productId differs', () => {
    const keySet = buildProductKeySet('SKU-7926913408');
    const entry = { productId: 'some-other-id', sku: 'SKU-7926913408', quantity: 1 };
    expect(binEntryMatchesKeySet(entry, keySet)).toBe(true);
  });

  it('matches SKU with prefix stripping (entry has SKU-, keySet has bare number)', () => {
    const keySet = new Set(['7926913408']);
    const entry = { productId: 'abc', sku: 'SKU-7926913408', quantity: 1 };
    expect(binEntryMatchesKeySet(entry, keySet)).toBe(true);
  });

  it('matches EAN from product data against entry productId', () => {
    const productData = {
      details: { identifiers: { ean: '0313030022097' } },
    };
    const keySet = buildProductKeySet(productData);
    const entry = { productId: '0313030022097', sku: 'SKU-999', quantity: 1 };
    expect(binEntryMatchesKeySet(entry, keySet)).toBe(true);
  });

  it('matches case-insensitively', () => {
    const keySet = buildProductKeySet('SKU-ABC123');
    const entry = { productId: 'x', sku: 'sku-abc123', quantity: 1 };
    expect(binEntryMatchesKeySet(entry, keySet)).toBe(true);
  });

  it('does NOT match unrelated entries', () => {
    const keySet = buildProductKeySet('0313030022097');
    const entry = { productId: '9999999999999', sku: 'SKU-0000000000', quantity: 1 };
    expect(binEntryMatchesKeySet(entry, keySet)).toBe(false);
  });

  it('does NOT match null/undefined entries', () => {
    const keySet = buildProductKeySet('0313030022097');
    expect(binEntryMatchesKeySet(null, keySet)).toBe(false);
    expect(binEntryMatchesKeySet(undefined, keySet)).toBe(false);
  });

  it('matches combined productId + product data keySet', () => {
    // Simulates the real flow: docId is an EAN, product has SKU, bin entry stored with SKU
    const productData = {
      id: '4260566841011',
      identification: { sku: 'SKU-0698797502' },
      details: { identifiers: { sku: 'SKU-0698797502', ean: '4260566841011' } },
    };
    const keySet = buildProductKeySet(productData);
    keySet.add(normalizeKey('4260566841011')); // docId

    // Bin entry was stored with SKU as productId (common mismatch scenario)
    const entry = { productId: 'SKU-0698797502', sku: 'SKU-0698797502', quantity: 1 };
    expect(binEntryMatchesKeySet(entry, keySet)).toBe(true);

    // Bin entry was stored with EAN as productId
    const entry2 = { productId: '4260566841011', sku: 'SKU-0698797502', quantity: 1 };
    expect(binEntryMatchesKeySet(entry2, keySet)).toBe(true);

    // Bin entry with bare number (no SKU- prefix)
    const entry3 = { productId: '0698797502', sku: '0698797502', quantity: 1 };
    expect(binEntryMatchesKeySet(entry3, keySet)).toBe(true);
  });
});
