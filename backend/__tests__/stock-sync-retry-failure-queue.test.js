// globals: true in vitest.config.js — describe/it/expect/vi are global

let stockSyncFailuresAdds = [];
let stockOperationFailuresAdds = [];
let ebayListingsLiveDocs = [];
const reviseCalls = [];
let mockReviseImpl = async () => { throw new Error('ebay revise down'); };
let mockEndImpl = async () => { throw new Error('ebay fail-safe down'); };

const mockFirestore = {
  collection: vi.fn((name) => {
    if (name === 'products_v2') {
      return {
        doc: vi.fn(() => ({
          get: async () => ({ exists: false }),
          set: async () => {},
          update: async () => {},
        })),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        get: async () => ({ empty: true, docs: [] }),
      };
    }
    if (name === 'stock_sync_failures') {
      return {
        add: vi.fn(async (doc) => {
          stockSyncFailuresAdds.push(doc);
        }),
      };
    }
    if (name === 'stock_operation_failures') {
      return {
        add: vi.fn(async (doc) => {
          stockOperationFailuresAdds.push(doc);
        }),
      };
    }
    if (name === 'stock_sync_log') {
      return {
        add: vi.fn(async () => {}),
      };
    }
    if (name === 'ebayListingsLive') {
      const chain = {
        _sku: null,
        where: vi.fn((field, _op, value) => {
          if (field === 'sku') chain._sku = value;
          return chain;
        }),
        limit: vi.fn(() => chain),
        get: async () => {
          const docs = ebayListingsLiveDocs
            .filter((row) => !chain._sku || row.sku === chain._sku)
            .map((row) => ({
              id: row.id,
              data: () => ({ ...row }),
            }));
          return { empty: docs.length === 0, docs };
        },
      };
      return chain;
    }
    return {
      add: vi.fn(async () => {}),
      doc: vi.fn(() => ({ get: async () => ({ exists: false }) })),
    };
  }),
};

require.cache[require.resolve('../lib/firestore')] = {
  id: require.resolve('../lib/firestore'),
  filename: require.resolve('../lib/firestore'),
  loaded: true,
  exports: { firestore: mockFirestore },
  children: [],
  paths: [],
};

require.cache[require.resolve('../lib/stock-lock')] = {
  id: require.resolve('../lib/stock-lock'),
  filename: require.resolve('../lib/stock-lock'),
  loaded: true,
  exports: {
    withStockLock: async (_key, fn) => fn(),
  },
  children: [],
  paths: [],
};

require.cache[require.resolve('../lib/ebay-trading-api')] = {
  id: require.resolve('../lib/ebay-trading-api'),
  filename: require.resolve('../lib/ebay-trading-api'),
  loaded: true,
  exports: {
    reviseFixedPriceItem: async (payload) => {
      reviseCalls.push(payload);
      return mockReviseImpl(payload);
    },
    endFixedPriceItem: async (...args) => mockEndImpl(...args),
  },
  children: [],
  paths: [],
};

const { syncStockWithRetry } = require('../services/stock-sync-dispatcher');
const { MARKETPLACE_ERROR_CLASSES } = require('../lib/marketplace-error-classifier');

describe('syncStockWithRetry failure queue integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stockSyncFailuresAdds = [];
    stockOperationFailuresAdds = [];
    ebayListingsLiveDocs = [];
    reviseCalls.length = 0;
    mockReviseImpl = async () => { throw new Error('ebay revise down'); };
    mockEndImpl = async () => { throw new Error('ebay fail-safe down'); };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('persists persistent channel failures to operation drain queue', async () => {
    await syncStockWithRetry({
      tenantId: 'trendocean',
      reason: 'event:stock-changed',
      product: {
        id: 'prod-sync-1',
        tenantId: 'trendocean',
        identification: { sku: 'SKU-SYNC-1' },
        inventory: { quantity: 3 },
        ops: { ebay: { itemId: 'EBAY-123' } },
      },
    });

    await vi.advanceTimersByTimeAsync(30000);

    expect(stockSyncFailuresAdds.length).toBe(1);
    expect(stockOperationFailuresAdds.length).toBe(1);
    const opFailure = stockOperationFailuresAdds[0];
    expect(opFailure.status).toBe('pending');
    expect(opFailure.operation).toBe('stock-sync');
    expect(Array.isArray(opFailure.failures)).toBe(true);
    expect(opFailure.failures[0].step).toBe('marketplaceSync');
    expect(opFailure.failures[0].sku).toBe('SKU-SYNC-1');
    expect(opFailure.failures[0].productId).toBe('prod-sync-1');
  });

  it('does not enqueue operation failures when queueing is explicitly skipped', async () => {
    await syncStockWithRetry({
      tenantId: 'trendocean',
      reason: 'drain:failure-doc',
      skipPersistentFailureQueue: true,
      product: {
        id: 'prod-sync-2',
        tenantId: 'trendocean',
        identification: { sku: 'SKU-SYNC-2' },
        inventory: { quantity: 4 },
        ops: { ebay: { itemId: 'EBAY-456' } },
      },
    });

    await vi.advanceTimersByTimeAsync(30000);

    expect(stockSyncFailuresAdds.length).toBe(0);
    expect(stockOperationFailuresAdds.length).toBe(0);
  });

  it('resolves missing ebay itemId from live listing by sku', async () => {
    mockReviseImpl = async () => ({ ack: 'Success' });
    mockEndImpl = async () => ({ ack: 'Success' });
    ebayListingsLiveDocs = [
      { id: '389918495952', itemId: '389918495952', sku: 'SKU-LIVE-1', active: true },
    ];

    await syncStockWithRetry({
      tenantId: 'trendocean',
      reason: 'event:stock-changed',
      product: {
        id: 'prod-live-1',
        tenantId: 'trendocean',
        identification: { sku: 'SKU-LIVE-1' },
        inventory: { quantity: 2 },
        ops: {},
      },
    });

    expect(reviseCalls.length).toBeGreaterThan(0);
    expect(reviseCalls[0].itemId).toBe('389918495952');
  });
});

describe('syncStockWithRetry — durable drain flag (WP1 Task 4)', () => {
  const PREV = process.env.SYNC_DURABLE_DRAIN;

  beforeEach(() => {
    stockSyncFailuresAdds = [];
    stockOperationFailuresAdds = [];
    ebayListingsLiveDocs = [];
    reviseCalls.length = 0;
    mockReviseImpl = async () => { throw new Error('ebay revise down'); };
    mockEndImpl = async () => { throw new Error('ebay fail-safe down'); };
  });

  afterEach(() => {
    if (PREV === undefined) delete process.env.SYNC_DURABLE_DRAIN;
    else process.env.SYNC_DURABLE_DRAIN = PREV;
  });

  it('flag ON: persists synchronously (no 30s setTimeout) and stamps classification + nextRetryAt', async () => {
    process.env.SYNC_DURABLE_DRAIN = 'true';
    const before = Date.now();

    await syncStockWithRetry({
      tenantId: 'trendocean',
      reason: 'event:stock-changed',
      product: {
        id: 'prod-durable-1',
        tenantId: 'trendocean',
        identification: { sku: 'SKU-DUR-1' },
        inventory: { quantity: 3 },
        ops: { ebay: { itemId: 'EBAY-DUR-1' } },
      },
    });

    // No timer advance — proves the persist happened synchronously, not via setTimeout.
    expect(stockOperationFailuresAdds.length).toBe(1);
    const doc = stockOperationFailuresAdds[0];
    expect(doc.status).toBe('pending');
    expect(doc.attempts).toBe(0);
    expect(MARKETPLACE_ERROR_CLASSES).toContain(doc.classification);
    expect(Date.parse(doc.nextRetryAt)).toBeGreaterThanOrEqual(before);
    expect(doc.failures[0].step).toBe('marketplaceSync');
  });

  it('flag OFF: keeps legacy setTimeout path (no persist until 30s elapse)', async () => {
    process.env.SYNC_DURABLE_DRAIN = 'false';
    vi.useFakeTimers();
    try {
      await syncStockWithRetry({
        tenantId: 'trendocean',
        reason: 'event:stock-changed',
        product: {
          id: 'prod-legacy-1',
          tenantId: 'trendocean',
          identification: { sku: 'SKU-LEG-1' },
          inventory: { quantity: 3 },
          ops: { ebay: { itemId: 'EBAY-LEG-1' } },
        },
      });

      // setTimeout still pending → nothing persisted yet.
      expect(stockOperationFailuresAdds.length).toBe(0);
      await vi.advanceTimersByTimeAsync(30000);
      expect(stockOperationFailuresAdds.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
