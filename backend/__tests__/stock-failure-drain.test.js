// globals: true in vitest.config.js — describe/it/expect/vi are global

// ─── Mock Setup (require.cache patching for CJS) ──────────────────────

function makeFailureDoc({ id, tenantId = 'trendocean', status = 'pending', attempts = 0, failures = [], createdAt = new Date().toISOString() }) {
  const data = { tenantId, status, attempts, failures, createdAt };
  const updates = [];
  return {
    id,
    ref: {
      update: vi.fn(async (patch) => { updates.push(patch); Object.assign(data, patch); }),
    },
    data: () => ({ ...data }),
    _updates: updates,
    _currentData: () => data,
  };
}

// Default query implementation - gets reassigned per test
let _queryImpl = async () => ({ docs: [] });
let _productQueryImpl = async () => ({ empty: true, docs: [] });
let _productDocGetImpl = async () => ({ exists: false, id: null, data: () => ({}) });

const mockFirestore = {
  collection: vi.fn((name) => {
    if (name === 'stock_operation_failures') {
      return {
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        get: async () => _queryImpl(),
      };
    }
    if (name === 'products_v2') {
      return {
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        get: async () => _productQueryImpl(),
        doc: vi.fn((id) => ({
          get: async () => _productDocGetImpl(id),
        })),
      };
    }
    return { where: vi.fn().mockReturnThis(), orderBy: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), get: async () => ({ docs: [] }) };
  }),
};

// mock firestore lib (the one lib/firestore.js exports via module.exports.firestore)
require.cache[require.resolve('../lib/firestore')] = {
  id: require.resolve('../lib/firestore'),
  filename: require.resolve('../lib/firestore'),
  loaded: true,
  exports: { firestore: mockFirestore },
  children: [],
  paths: [],
};

// mock stock-sync-dispatcher
const syncStockWithRetryMock = vi.fn();
require.cache[require.resolve('../services/stock-sync-dispatcher')] = {
  id: require.resolve('../services/stock-sync-dispatcher'),
  filename: require.resolve('../services/stock-sync-dispatcher'),
  loaded: true,
  exports: { syncStockWithRetry: syncStockWithRetryMock },
  children: [],
  paths: [],
};

// Now require drain AFTER mocks are in place
const { drainStockFailures, MAX_ATTEMPTS } = require('../services/stock-failure-drain');

// ─── Tests ────────────────────────────────────────────────────────────

beforeEach(() => {
  syncStockWithRetryMock.mockReset();
  _queryImpl = async () => ({ docs: [] });
  _productQueryImpl = async () => ({ empty: true, docs: [] });
  _productDocGetImpl = async () => ({ exists: false, id: null, data: () => ({}) });
});

describe('drainStockFailures', () => {
  it('requires tenantId', async () => {
    await expect(drainStockFailures({})).rejects.toThrow(/tenantId required/);
  });

  it('returns zero counts for empty collection', async () => {
    const r = await drainStockFailures({ tenantId: 'trendocean' });
    expect(r.total).toBe(0);
    expect(r.resolved).toBe(0);
  });

  it('resolves a doc when marketplaceSync retry succeeds', async () => {
    const doc = makeFailureDoc({
      id: 'f1',
      failures: [{ step: 'marketplaceSync', sku: 'SKU-A', error: 'eBay timeout' }],
    });
    _queryImpl = async () => ({ docs: [doc] });
    _productQueryImpl = async () => ({
      empty: false,
      docs: [{ id: 'prod-1', data: () => ({ id: 'prod-1', identification: { sku: 'SKU-A' }, tenantId: 'trendocean' }) }],
    });
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'ebay', status: 'success' }] });

    const r = await drainStockFailures({ tenantId: 'trendocean' });
    expect(r.resolved).toBe(1);
    expect(r.stillFailing).toBe(0);
    expect(syncStockWithRetryMock).toHaveBeenCalledTimes(1);
    expect(doc._currentData().status).toBe('resolved');
    expect(doc._currentData().attempts).toBe(1);
  });

  it('marks as stillFailing when retry reports channel error, increments attempts', async () => {
    const doc = makeFailureDoc({
      id: 'f2',
      failures: [{ step: 'marketplaceSync', sku: 'SKU-B' }],
      attempts: 0,
    });
    _queryImpl = async () => ({ docs: [doc] });
    _productQueryImpl = async () => ({
      empty: false,
      docs: [{ id: 'prod-2', data: () => ({ identification: { sku: 'SKU-B' }, tenantId: 'trendocean' }) }],
    });
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'ebay', status: 'error', error: 'still down' }] });

    const r = await drainStockFailures({ tenantId: 'trendocean' });
    expect(r.stillFailing).toBe(1);
    expect(r.resolved).toBe(0);
    expect(doc._currentData().status).toBe('pending');
    expect(doc._currentData().attempts).toBe(1);
  });

  it('marks as abandoned after MAX_ATTEMPTS failed retries', async () => {
    const doc = makeFailureDoc({
      id: 'f3',
      failures: [{ step: 'marketplaceSync', sku: 'SKU-C' }],
      attempts: MAX_ATTEMPTS - 1,
    });
    _queryImpl = async () => ({ docs: [doc] });
    _productQueryImpl = async () => ({
      empty: false,
      docs: [{ id: 'prod-3', data: () => ({ identification: { sku: 'SKU-C' }, tenantId: 'trendocean' }) }],
    });
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'ebay', status: 'error', error: 'permanent' }] });

    const r = await drainStockFailures({ tenantId: 'trendocean' });
    expect(r.abandoned).toBe(1);
    expect(doc._currentData().status).toBe('abandoned');
    expect(doc._currentData().attempts).toBe(MAX_ATTEMPTS);
  });

  it('skips docs with status != pending', async () => {
    const resolved = makeFailureDoc({ id: 'f4', status: 'resolved', failures: [{ step: 'marketplaceSync', sku: 'X' }] });
    const abandoned = makeFailureDoc({ id: 'f5', status: 'abandoned', failures: [{ step: 'marketplaceSync', sku: 'Y' }] });
    _queryImpl = async () => ({ docs: [resolved, abandoned] });

    const r = await drainStockFailures({ tenantId: 'trendocean' });
    expect(r.total).toBe(0);
    expect(syncStockWithRetryMock).not.toHaveBeenCalled();
  });

  it('marks needs_manual when only decrement failures present', async () => {
    const doc = makeFailureDoc({
      id: 'f6',
      failures: [{ step: 'decrement', sku: 'SKU-D', qty: 1, error: 'product not found' }],
    });
    _queryImpl = async () => ({ docs: [doc] });

    const r = await drainStockFailures({ tenantId: 'trendocean' });
    expect(r.needsManual).toBe(1);
    expect(r.resolved).toBe(0);
    expect(doc._currentData().status).toBe('needs_manual');
    expect(syncStockWithRetryMock).not.toHaveBeenCalled();
  });

  it('handles mix of decrement + marketplaceSync by retrying only marketplaceSync and marking needs_manual', async () => {
    const doc = makeFailureDoc({
      id: 'f7',
      failures: [
        { step: 'decrement', sku: 'SKU-E', qty: 1, error: 'not found' },
        { step: 'marketplaceSync', sku: 'SKU-F' },
      ],
    });
    _queryImpl = async () => ({ docs: [doc] });
    _productQueryImpl = async () => ({
      empty: false,
      docs: [{ id: 'prod-f', data: () => ({ identification: { sku: 'SKU-F' }, tenantId: 'trendocean' }) }],
    });
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'ebay', status: 'success' }] });

    const r = await drainStockFailures({ tenantId: 'trendocean' });
    expect(r.needsManual).toBe(1);
    expect(doc._currentData().status).toBe('needs_manual');
    expect(syncStockWithRetryMock).toHaveBeenCalledTimes(1);
  });

  it('deduplicates retry attempts for repeated channel failures of same product', async () => {
    const doc = makeFailureDoc({
      id: 'f-dedupe',
      failures: [
        { step: 'marketplaceSync', sku: 'SKU-DED', channel: 'ebay', error: 'timeout' },
        { step: 'marketplaceSync', sku: 'SKU-DED', channel: 'kaufland', error: 'timeout' },
      ],
    });
    _queryImpl = async () => ({ docs: [doc] });
    _productQueryImpl = async () => ({
      empty: false,
      docs: [{ id: 'prod-ded', data: () => ({ identification: { sku: 'SKU-DED' }, tenantId: 'trendocean' }) }],
    });
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'ebay', status: 'success' }] });

    const r = await drainStockFailures({ tenantId: 'trendocean' });
    expect(r.resolved).toBe(1);
    expect(syncStockWithRetryMock).toHaveBeenCalledTimes(1);
  });

  it('handles missing product gracefully', async () => {
    const doc = makeFailureDoc({
      id: 'f8',
      failures: [{ step: 'marketplaceSync', sku: 'SKU-MISSING' }],
    });
    _queryImpl = async () => ({ docs: [doc] });
    _productQueryImpl = async () => ({ empty: true, docs: [] });

    const r = await drainStockFailures({ tenantId: 'trendocean' });
    expect(r.stillFailing + r.abandoned).toBe(1);
    expect(syncStockWithRetryMock).not.toHaveBeenCalled();
  });

  it('resolves product via productId fallback when failure has no sku', async () => {
    const doc = makeFailureDoc({
      id: 'f9',
      failures: [{ step: 'marketplaceSync', productId: 'prod-9', error: 'sync timeout' }],
    });
    _queryImpl = async () => ({ docs: [doc] });
    _productDocGetImpl = async (id) => ({
      exists: id === 'prod-9',
      id: 'prod-9',
      data: () => ({ identification: { sku: 'SKU-P9' }, tenantId: 'trendocean' }),
    });
    syncStockWithRetryMock.mockResolvedValue({ results: [{ channel: 'ebay', status: 'success' }] });

    const r = await drainStockFailures({ tenantId: 'trendocean' });
    expect(r.resolved).toBe(1);
    expect(syncStockWithRetryMock).toHaveBeenCalledTimes(1);
    expect(syncStockWithRetryMock.mock.calls[0][0].product.id).toBe('prod-9');
    expect(doc._currentData().status).toBe('resolved');
  });

  it('skips with skipped reason when STOCK_FAILURE_DRAIN_ENABLED=false', async () => {
    const prev = process.env.STOCK_FAILURE_DRAIN_ENABLED;
    process.env.STOCK_FAILURE_DRAIN_ENABLED = 'false';
    try {
      const r = await drainStockFailures({ tenantId: 'trendocean' });
      expect(r.skipped).toBe(true);
      expect(r.reason).toMatch(/STOCK_FAILURE_DRAIN_ENABLED=false/);
    } finally {
      if (prev === undefined) delete process.env.STOCK_FAILURE_DRAIN_ENABLED;
      else process.env.STOCK_FAILURE_DRAIN_ENABLED = prev;
    }
  });
});
