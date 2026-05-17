'use strict';

/**
 * Service-level tests for services/kaufland-listings-sync.js.
 *
 * Uses require.cache patching (Vitest 4.x cannot mock CJS modules via
 * vi.mock(). See _patchGcp.js / _patchLocalModules.js for the pattern.)
 *
 * Plan-D.0d — backs the extracted Kaufland listings-cache sync that the new
 * safety-net cron in backend/index.js fans out to multiple tenants.
 */

// vitest globals: true — describe/it/expect/vi are global.

// ─── Mock setup: register fake modules in require.cache BEFORE require()'ing target ───

function installModuleMock(modulePath, mockExports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: mockExports,
    children: [],
    paths: [],
  };
  return resolved;
}

// Captured Firestore writes so assertions can inspect what was persisted.
const writes = [];

function makeBatch() {
  return {
    set: vi.fn((ref, payload, opts) => {
      writes.push({ kind: 'set', ref, payload, opts });
    }),
    update: vi.fn((ref, patch) => {
      writes.push({ kind: 'update', ref, patch });
    }),
    commit: vi.fn().mockResolvedValue([]),
  };
}

let _kauflandUnitsLiveExistingDocs = [];

const mockFirestore = {
  collection: vi.fn((name) => {
    if (name === 'kauflandUnitsLive') {
      return {
        doc: vi.fn((id) => ({ __collection: 'kauflandUnitsLive', __id: id })),
        where: vi.fn().mockReturnThis(),
        get: async () => ({
          empty: _kauflandUnitsLiveExistingDocs.length === 0,
          docs: _kauflandUnitsLiveExistingDocs,
        }),
      };
    }
    if (name === 'products_v2') {
      return {
        doc: vi.fn((id) => ({ __collection: 'products_v2', __id: id })),
      };
    }
    return {
      doc: vi.fn((id) => ({ __collection: name, __id: id })),
      where: vi.fn().mockReturnThis(),
      get: async () => ({ empty: true, docs: [] }),
    };
  }),
  batch: vi.fn(() => makeBatch()),
};

// lib/firestore — only `firestore` is needed by the service.
installModuleMock('../../lib/firestore', { firestore: mockFirestore });

// lib/kaufland-api — fake listUnits() + getUnit()
const listUnitsMock = vi.fn();
const getUnitMock = vi.fn();
installModuleMock('../../lib/kaufland-api', { listUnits: listUnitsMock, getUnit: getUnitMock });

// lib/product-store — both reads
const getAllProductsV2Mock = vi.fn();
const getAllProductsV2ForTenantMock = vi.fn();
installModuleMock('../../lib/product-store', {
  getAllProductsV2: getAllProductsV2Mock,
  getAllProductsV2ForTenant: getAllProductsV2ForTenantMock,
});

// services/stock-sync-dispatcher — only syncStockWithRetry is consumed
const syncStockWithRetryMock = vi.fn();
installModuleMock('../../services/stock-sync-dispatcher', {
  syncStockWithRetry: syncStockWithRetryMock,
});

// @google-cloud/firestore — only Timestamp.now() is consumed by the service.
// We do NOT replace Firestore the class; we just stub the Timestamp helper.
try {
  const gcpResolved = require.resolve('@google-cloud/firestore');
  const existing = require.cache[gcpResolved]?.exports || {};
  require.cache[gcpResolved] = {
    id: gcpResolved,
    filename: gcpResolved,
    loaded: true,
    exports: Object.assign({}, existing, {
      Timestamp: {
        now: () => ({ __mock: true, seconds: 1700000000 }),
        fromDate: (d) => ({ __mock: true, seconds: Math.floor((d?.getTime?.() || 0) / 1000) }),
      },
    }),
    children: [],
    paths: [],
  };
} catch (_) { /* package not installed in test env — ignore */ }

// ─── Now require the SUT ─────────────────────────────────────────────────
const { syncKauflandListingsCache } = require('../../services/kaufland-listings-sync');

// ─── Tests ───────────────────────────────────────────────────────────────

beforeEach(() => {
  writes.length = 0;
  _kauflandUnitsLiveExistingDocs = [];
  listUnitsMock.mockReset();
  getUnitMock.mockReset();
  getAllProductsV2Mock.mockReset();
  getAllProductsV2ForTenantMock.mockReset();
  syncStockWithRetryMock.mockReset();
  mockFirestore.collection.mockClear();
  mockFirestore.batch.mockClear();
});

describe('syncKauflandListingsCache', () => {
  it('persists fetched Kaufland units to kauflandUnitsLive and returns shape', async () => {
    listUnitsMock.mockResolvedValueOnce([
      {
        id_unit: 1001,
        id_offer: 'SKU-A',
        ean: '4012345678901',
        amount: 5,
        status: 'AVAILABLE',
        storefront: 'de',
        listing_price: 19.99,
        product: { title: 'Test Title', eans: ['4012345678901'], id_product: 999, url: 'https://kaufland.de/p/999' },
      },
      {
        id_unit: 1002,
        id_offer: 'SKU-B',
        ean: '4012345678902',
        amount: 0,
        status: 'ONHOLD',
        storefront: 'de',
        product: {},
      },
    ]);
    getAllProductsV2ForTenantMock.mockResolvedValue([]);

    const result = await syncKauflandListingsCache({ tenantId: 'trendocean', storefront: 'de' });

    expect(result.storefront).toBe('de');
    expect(result.fetched).toBe(2);
    expect(result.active).toBe(2);
    expect(result.driftsDetected).toBe(0);
    expect(result.reconciled).toBe(0);
    expect(result.reverseDriftsDetected).toBe(0);
    expect(result.reverseDriftSamples).toEqual([]);

    // Each unit triggered a batch.set onto kauflandUnitsLive (main payload).
    // The validity-refresh phase may add additional product_valid-only writes
    // for AVAILABLE units — filter them out to assert the main sync writes.
    const mainCacheWrites = writes.filter(
      (w) => w.kind === 'set'
        && w.ref.__collection === 'kauflandUnitsLive'
        && w.payload
        && Object.prototype.hasOwnProperty.call(w.payload, 'id_unit')
    );
    expect(mainCacheWrites.length).toBe(2);
    expect(mainCacheWrites[0].payload.id_unit).toBe(1001);
    expect(mainCacheWrites[0].payload.active).toBe(true); // AVAILABLE
    expect(mainCacheWrites[1].payload.id_unit).toBe(1002);
    expect(mainCacheWrites[1].payload.active).toBe(false); // ONHOLD

    // listUnits was called with the storefront param
    expect(listUnitsMock).toHaveBeenCalledWith(expect.objectContaining({ storefront: 'de', limit: 100, maxPages: 300 }));

    // Tenant-scoped product read was used (not the global one) since tenantId was passed.
    expect(getAllProductsV2ForTenantMock).toHaveBeenCalledWith('trendocean');
    expect(getAllProductsV2Mock).not.toHaveBeenCalled();

    // No drift → no outbound stock sync
    expect(syncStockWithRetryMock).not.toHaveBeenCalled();
  });

  it('falls back to global product read when tenantId is omitted (legacy behaviour)', async () => {
    listUnitsMock.mockResolvedValueOnce([]);
    getAllProductsV2Mock.mockResolvedValue([]);

    const result = await syncKauflandListingsCache({ storefront: 'de' });

    expect(result.fetched).toBe(0);
    expect(getAllProductsV2Mock).toHaveBeenCalled();
    expect(getAllProductsV2ForTenantMock).not.toHaveBeenCalled();
  });

  it('queues an outbound stock sync when forward drift is detected (kaufland>0 vs warehouse=0)', async () => {
    listUnitsMock.mockResolvedValueOnce([
      {
        id_unit: 2001,
        id_offer: 'SKU-DRIFT',
        ean: '',
        amount: 3,
        status: 'AVAILABLE',
        storefront: 'de',
        product: {},
      },
    ]);
    getAllProductsV2ForTenantMock.mockResolvedValue([
      {
        id: 'prod-drift',
        identification: { sku: 'SKU-DRIFT' },
        inventory: { quantity: 0 },
        tenantId: 'trendocean',
      },
    ]);
    syncStockWithRetryMock.mockResolvedValue({ ok: true });

    const result = await syncKauflandListingsCache({ tenantId: 'trendocean', storefront: 'de' });

    expect(result.driftsDetected).toBe(1);
    expect(result.reconciled).toBe(1);
    expect(syncStockWithRetryMock).toHaveBeenCalledTimes(1);
    expect(syncStockWithRetryMock.mock.calls[0][0]).toEqual(expect.objectContaining({
      tenantId: 'trendocean',
      reason: 'kaufland-drift-detected',
    }));
  });

  it('tombstones stale docs with status=STALE when they disappear from API response', async () => {
    // Pre-existing cache: two docs about to vanish, plus one already tombstoned.
    _kauflandUnitsLiveExistingDocs = [
      {
        id: '5001',
        data: () => ({ active: true, status: 'AVAILABLE', storefront: 'de' }),
      },
      {
        id: '5002',
        data: () => ({ active: false, status: 'ONHOLD', storefront: 'de' }),
      },
      {
        id: '5003', // already tombstoned — must NOT be re-written
        data: () => ({ active: false, status: 'STALE', storefront: 'de' }),
      },
    ];
    listUnitsMock.mockResolvedValueOnce([]); // API returns nothing → all existing docs are ghosts
    getAllProductsV2ForTenantMock.mockResolvedValue([]);

    await syncKauflandListingsCache({ tenantId: 'trendocean', storefront: 'de' });

    const staleWrites = writes.filter(
      (w) => w.kind === 'set' && w.payload && w.payload.status === 'STALE'
    );
    expect(staleWrites).toHaveLength(2);
    expect(staleWrites.map((w) => w.ref.__id).sort()).toEqual(['5001', '5002']);
    for (const w of staleWrites) {
      expect(w.payload.active).toBe(false);
      expect(w.payload.removedAt).toBeDefined();
      expect(w.payload.source).toBe('kaufland-sync-stale');
    }
  });

  it('reports reverse drift WITHOUT auto-reactivating (warehouse>0 vs kaufland=0/ONHOLD)', async () => {
    listUnitsMock.mockResolvedValueOnce([
      {
        id_unit: 3001,
        id_offer: 'SKU-REV',
        ean: '',
        amount: 0,
        status: 'ONHOLD',
        storefront: 'de',
        product: {},
      },
    ]);
    getAllProductsV2ForTenantMock.mockResolvedValue([
      {
        id: 'prod-rev',
        identification: { sku: 'SKU-REV', ean: '' },
        inventory: { quantity: 7 },
        tenantId: 'trendocean',
      },
    ]);

    const result = await syncKauflandListingsCache({ tenantId: 'trendocean', storefront: 'de' });

    expect(result.driftsDetected).toBe(0);
    expect(result.reverseDriftsDetected).toBe(1);
    expect(result.reverseDriftSamples).toHaveLength(1);
    expect(result.reverseDriftSamples[0]).toEqual(expect.objectContaining({
      sku: 'SKU-REV',
      warehouseQty: 7,
      kauflandAmount: 0,
      kauflandStatus: 'ONHOLD',
    }));
    // Report-only path: no outbound sync
    expect(syncStockWithRetryMock).not.toHaveBeenCalled();
  });

  // ── Validity-refresh phase ─────────────────────────────────────────────
  // Splits the binary AVAILABLE bucket into Live (product.is_valid=true ==
  // Kaufland Portal "Aktiv") and Indexierung läuft (product.is_valid=false,
  // freshly listed, Kaufland still indexing).

  it('fetches product.is_valid for newly-AVAILABLE units (no cache entry)', async () => {
    listUnitsMock.mockResolvedValueOnce([
      {
        id_unit: 7001,
        id_offer: 'SKU-NEW',
        ean: '4012345678901',
        amount: 5,
        status: 'AVAILABLE',
        storefront: 'de',
        product: {},
      },
    ]);
    // No existing cache doc → neverChecked → enqueued for validity refresh.
    _kauflandUnitsLiveExistingDocs = [];
    getAllProductsV2ForTenantMock.mockResolvedValue([]);
    getUnitMock.mockResolvedValueOnce({ product: { is_valid: true } });

    const result = await syncKauflandListingsCache({ tenantId: 'trendocean', storefront: 'de' });

    expect(getUnitMock).toHaveBeenCalledTimes(1);
    expect(getUnitMock).toHaveBeenCalledWith(7001, expect.objectContaining({
      storefront: 'de',
      embedded: 'products',
    }));
    expect(result.validityChecked).toBe(1);
    expect(result.validityValid).toBe(1);
    expect(result.validityInvalid).toBe(0);

    const validityWrites = writes.filter(
      (w) => w.kind === 'set' && w.payload && Object.prototype.hasOwnProperty.call(w.payload, 'product_valid')
    );
    expect(validityWrites).toHaveLength(1);
    expect(validityWrites[0].payload.product_valid).toBe(true);
    expect(validityWrites[0].payload.product_validity_checked_at).toBeDefined();
    expect(validityWrites[0].ref.__id).toBe('7001');
  });

  it('skips validity check when cached fresh (<24h) and was valid', async () => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    listUnitsMock.mockResolvedValueOnce([
      {
        id_unit: 7100,
        id_offer: 'SKU-CACHED',
        ean: '',
        amount: 5,
        status: 'AVAILABLE',
        storefront: 'de',
        product: {},
      },
    ]);
    // Pre-existing cache doc: product_valid=true, checked 1h ago (fresh).
    _kauflandUnitsLiveExistingDocs = [
      {
        id: '7100',
        data: () => ({
          active: true,
          status: 'AVAILABLE',
          storefront: 'de',
          product_valid: true,
          // numeric timestamp path (also supports Firestore Timestamp w/ toDate())
          product_validity_checked_at: oneHourAgo,
        }),
      },
    ];
    getAllProductsV2ForTenantMock.mockResolvedValue([]);

    const result = await syncKauflandListingsCache({ tenantId: 'trendocean', storefront: 'de' });

    // No getUnit call because cache is fresh + was valid.
    expect(getUnitMock).not.toHaveBeenCalled();
    expect(result.validityChecked).toBe(0);
    expect(result.validityValid).toBe(0);
    expect(result.validityInvalid).toBe(0);

    // No product_valid write either (only the main payload set).
    const validityWrites = writes.filter(
      (w) => w.kind === 'set' && w.payload && Object.prototype.hasOwnProperty.call(w.payload, 'product_valid')
    );
    expect(validityWrites).toHaveLength(0);
  });

  it('re-checks validity when last seen invalid (allows flip to valid)', async () => {
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    listUnitsMock.mockResolvedValueOnce([
      {
        id_unit: 7200,
        id_offer: 'SKU-FLIP',
        ean: '',
        amount: 2,
        status: 'AVAILABLE',
        storefront: 'de',
        product: {},
      },
    ]);
    // Cache: was invalid 5 min ago (fresh by TTL, but wasInvalid → re-check).
    _kauflandUnitsLiveExistingDocs = [
      {
        id: '7200',
        data: () => ({
          active: true,
          status: 'AVAILABLE',
          storefront: 'de',
          product_valid: false,
          product_validity_checked_at: fiveMinAgo,
        }),
      },
    ];
    getAllProductsV2ForTenantMock.mockResolvedValue([]);
    getUnitMock.mockResolvedValueOnce({ product: { is_valid: true } });

    const result = await syncKauflandListingsCache({ tenantId: 'trendocean', storefront: 'de' });

    expect(getUnitMock).toHaveBeenCalledTimes(1);
    expect(getUnitMock).toHaveBeenCalledWith(7200, expect.objectContaining({
      embedded: 'products',
    }));
    expect(result.validityChecked).toBe(1);
    expect(result.validityValid).toBe(1);
    expect(result.validityInvalid).toBe(0);

    const validityWrites = writes.filter(
      (w) => w.kind === 'set' && w.payload && Object.prototype.hasOwnProperty.call(w.payload, 'product_valid')
    );
    expect(validityWrites).toHaveLength(1);
    expect(validityWrites[0].payload.product_valid).toBe(true);
  });
});
