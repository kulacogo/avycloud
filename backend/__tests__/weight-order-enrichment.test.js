// backend/__tests__/weight-order-enrichment.test.js

// ─── Patch GCP before anything else ────────────────────────────────────────
require('./api/_patchGcp');

// ─── Stub shipping-engine dependencies before requiring it ─────────────────
const secretValuesPath = require.resolve('../lib/secret-values');
require.cache[secretValuesPath] = {
  id: secretValuesPath, filename: secretValuesPath, loaded: true,
  exports: { getSecretValue: vi.fn().mockResolvedValue('mock-secret') },
  children: [], paths: [],
};

const sendcloudPath = require.resolve('../lib/sendcloud');
require.cache[sendcloudPath] = {
  id: sendcloudPath, filename: sendcloudPath, loaded: true,
  exports: { lookupCsvPrice: vi.fn().mockResolvedValue(null) },
  children: [], paths: [],
};

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

describe('calculateOrderWeight', () => {
  it('uses order-level weight when available', () => {
    const { calculateOrderWeight } = require('../services/shipping-engine');
    expect(calculateOrderWeight({ weight: 5.0, items: [] })).toBe(5.0);
  });

  it('sums item weights when order weight missing', () => {
    const { calculateOrderWeight } = require('../services/shipping-engine');
    expect(calculateOrderWeight({
      items: [
        { weight: 2.0, quantity: 2 },
        { weight: 1.5, quantity: 1 },
      ],
    })).toBe(5.5);
  });

  it('returns null when no weights available (no fallback)', () => {
    const { calculateOrderWeight } = require('../services/shipping-engine');
    expect(calculateOrderWeight({ items: [{ quantity: 1 }] })).toBeNull();
  });

  it('returns null for empty order', () => {
    const { calculateOrderWeight } = require('../services/shipping-engine');
    expect(calculateOrderWeight({})).toBeNull();
  });
});

// ─── Stub remaining deps for order-intake-ebay ────────────────────────────────

const ebayTradingPath = require.resolve('../lib/ebay-trading-api');
require.cache[ebayTradingPath] = {
  id: ebayTradingPath, filename: ebayTradingPath, loaded: true,
  exports: { callTradingApi: vi.fn().mockResolvedValue({ response: {} }) },
  children: [], paths: [],
};

const numberSequencePath = require.resolve('../services/number-sequence');
require.cache[numberSequencePath] = {
  id: numberSequencePath, filename: numberSequencePath, loaded: true,
  exports: { getNextNumber: vi.fn().mockResolvedValue({ formatted: 'AVY-2026-0001', number: 1 }) },
  children: [], paths: [],
};

const stockReservationPath = require.resolve('../services/stock-reservation');
require.cache[stockReservationPath] = {
  id: stockReservationPath, filename: stockReservationPath, loaded: true,
  exports: { reserveStock: vi.fn().mockResolvedValue({}), confirmReservation: vi.fn(), releaseReservation: vi.fn() },
  children: [], paths: [],
};

const stockSyncDispatcherPath = require.resolve('../services/stock-sync-dispatcher');
require.cache[stockSyncDispatcherPath] = {
  id: stockSyncDispatcherPath, filename: stockSyncDispatcherPath, loaded: true,
  exports: { syncStockWithRetry: vi.fn().mockResolvedValue({}), syncStockToAllChannels: vi.fn() },
  children: [], paths: [],
};

const syncEventBusPath = require.resolve('../services/sync-event-bus');
require.cache[syncEventBusPath] = {
  id: syncEventBusPath, filename: syncEventBusPath, loaded: true,
  exports: { emitSyncEvent: vi.fn() },
  children: [], paths: [],
};

describe('eBay order intake — weight enrichment', () => {
  it('enriches items with product weight from SKU lookup', async () => {
    const productStore = require('../lib/product-store');
    productStore.getProductWeightBySku = vi.fn()
      .mockResolvedValueOnce(3.6)
      .mockResolvedValueOnce(1.2);

    const { enrichOrderItemsWithWeight } = require('../services/order-intake-ebay');
    const result = await enrichOrderItemsWithWeight([
      { name: 'Wechselrichter', sku: 'SKU-001', ean: 'EAN-001', quantity: 1, priceBrutto: 160.18 },
      { name: 'Kabel', sku: 'SKU-002', ean: null, quantity: 2, priceBrutto: 9.99 },
    ]);

    expect(result.items[0].weight).toBe(3.6);
    expect(result.items[1].weight).toBe(1.2);
    expect(result.orderWeight).toBe(3.6 + 1.2 * 2); // 6.0
  });

  it('sets orderWeight to null when any item has no weight', async () => {
    const productStore = require('../lib/product-store');
    productStore.getProductWeightBySku = vi.fn()
      .mockResolvedValueOnce(3.6)
      .mockResolvedValueOnce(null);

    const { enrichOrderItemsWithWeight } = require('../services/order-intake-ebay');
    const result = await enrichOrderItemsWithWeight([
      { name: 'Wechselrichter', sku: 'SKU-001', ean: 'EAN-001', quantity: 1, priceBrutto: 160.18 },
      { name: 'Unbekannt', sku: 'SKU-002', ean: null, quantity: 1, priceBrutto: 9.99 },
    ]);

    expect(result.items[0].weight).toBe(3.6);
    expect(result.items[1].weight).toBeUndefined();
    expect(result.orderWeight).toBeNull();
  });
});
