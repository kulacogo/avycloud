/**
 * Integration tests for POST /api/marketplace/kaufland/publish/bulk
 *
 * Covers the 4 publish hardenings + audit-log endpoint:
 *  - Deliverable 1: audit-log start/append/finalize calls on bulk-publish
 *  - Deliverable 3: publishWithOnHold=true keeps 0-stock products in flow
 *                    (autoFixProduct emits a Fix-Note instead of skipping)
 *  - Deliverable 5: GET /kaufland/publish-runs reads from Firestore
 *
 * Pattern: require.cache patching (no vi.mock for CJS). See _patchGcp.js +
 * _patchLocalModules.js + _setupMocks.js.
 */

const request = require('supertest');

require('./_patchGcp');
require('./_patchLocalModules');

// ── Patch local services so route uses our mocks ──────────────────────────
const path = require('path');

function patchLocal(modulePath, exportsObj) {
  try {
    const resolved = require.resolve(modulePath);
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports: exportsObj,
      children: [],
      paths: [],
    };
  } catch (_) { /* ignore */ }
}

// services/kaufland-publish-audit.js
const auditSpies = {
  startRun: vi.fn().mockResolvedValue('audit-run-123'),
  appendResult: vi.fn().mockResolvedValue(undefined),
  finalizeRun: vi.fn().mockResolvedValue(undefined),
};
patchLocal('../../services/kaufland-publish-audit.js', auditSpies);

// services/kaufland-product-data-repair.js — Agent A may not have built this
// yet, so we patch it pre-emptively. Default: no repair attempted.
const repairSpies = {
  tryRepairKauflandProductData: vi.fn().mockResolvedValue({ repaired: false, attemptedAttributes: [] }),
};
patchLocal('../../services/kaufland-product-data-repair.js', repairSpies);

// lib/integration-defaults.js — minimal stub
patchLocal('../../lib/integration-defaults.js', {
  mergeKauflandOverrides: vi.fn().mockResolvedValue({ shippingGroupId: 144080, warehouseId: 70462 }),
});

// lib/kaufland-api.js — override createUnit + pickUnitData for these tests
const kauflandApiSpies = {
  createUnit: vi.fn(),
  pickUnitData: vi.fn(() => ({ ean: '4006381333931', idOffer: 'SKU-1', storefront: 'de', unitData: {}, patchData: {} })),
};
patchLocal('../../lib/kaufland-api.js', kauflandApiSpies);

// lib/product-store.js — override getProductV2 (extend the patch from _patchLocalModules)
const productStoreSpies = {
  saveProductV2: vi.fn().mockResolvedValue({}),
  getAllProductsV2: vi.fn().mockResolvedValue([]),
  getAllProductsV2ForTenant: vi.fn().mockResolvedValue([]),
  getProductV2: vi.fn(),
};
patchLocal('../../lib/product-store.js', productStoreSpies);

// lib/gpsr-web-fallback.js — silence the web call
const gpsrSpies = {
  lookupGpsrFromWeb: vi.fn().mockResolvedValue({
    manufacturer_name: null,
    manufacturer_address: null,
    manufacturer_email: null,
    manufacturer_url: null,
    confidence: 0,
    sources: [],
  }),
};
patchLocal('../../lib/gpsr-web-fallback.js', gpsrSpies);

require('./_setupMocks');
const { createTestApp } = require('./_createApp');
const marketplaceRouter = require('../../routes/marketplace');
const firestoreModule = require('../../lib/firestore');

const app = createTestApp(marketplaceRouter);

// ── Helper to build a Kaufland-ready product fixture ──────────────────────
function buildProduct({ id = 'PROD-1', sku = 'SKU-1', ean = '4006381333931', sellPrice = 19.99, qty = 5, gpsr = true } = {}) {
  return {
    id,
    identification: { sku, name: 'Test Article', brand: 'TestBrand', barcodes: [ean] },
    inventory: { quantity: qty, availableQuantity: qty },
    details: {
      identifiers: { sku, ean },
      pricing: { sellPrice },
      kaufland: { id_shipping_group: 144080, id_warehouse: 70462 },
      gpsr: gpsr ? { manufacturer_name: 'Test GmbH', address: 'Teststr. 1, 12345 Berlin' } : undefined,
    },
  };
}

describe('POST /api/marketplace/kaufland/publish/bulk — audit logging', () => {
  beforeEach(() => {
    auditSpies.startRun.mockClear();
    auditSpies.appendResult.mockClear();
    auditSpies.finalizeRun.mockClear();
    productStoreSpies.getProductV2.mockReset();
    kauflandApiSpies.createUnit.mockReset();
    repairSpies.tryRepairKauflandProductData.mockClear();
  });

  it('calls startRun, appendResult (per product) and finalizeRun on success', async () => {
    productStoreSpies.getProductV2.mockResolvedValueOnce(buildProduct({ id: 'P1', sku: 'SKU-1' }));
    productStoreSpies.getProductV2.mockResolvedValueOnce(buildProduct({ id: 'P2', sku: 'SKU-2' }));
    kauflandApiSpies.createUnit.mockResolvedValue({ created: true, productDataSubmitted: false, id_unit: 9001, data: {} });

    const res = await request(app)
      .post('/api/kaufland/publish/bulk')
      .send({ productIds: ['P1', 'P2'], storefront: 'de' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.auditRunId).toBe('audit-run-123');
    expect(res.body.data.summary.total).toBe(2);

    expect(auditSpies.startRun).toHaveBeenCalledTimes(1);
    expect(auditSpies.startRun).toHaveBeenCalledWith(expect.objectContaining({
      storefront: 'de',
      source: 'ui-bulk',
      requestedProductIds: ['P1', 'P2'],
    }));
    expect(auditSpies.appendResult).toHaveBeenCalledTimes(2);
    expect(auditSpies.appendResult).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'audit-run-123',
      productId: 'P1',
      ok: true,
    }));
    expect(auditSpies.finalizeRun).toHaveBeenCalledTimes(1);
    expect(auditSpies.finalizeRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'audit-run-123',
      summary: expect.objectContaining({ total: 2, success: 2, repaired: 0 }),
    }));
  });

  it('does NOT block publish when audit.startRun rejects (best-effort)', async () => {
    auditSpies.startRun.mockRejectedValueOnce(new Error('audit-firestore-down'));
    productStoreSpies.getProductV2.mockResolvedValue(buildProduct());
    kauflandApiSpies.createUnit.mockResolvedValue({ created: true, productDataSubmitted: false, id_unit: 9002, data: {} });

    const res = await request(app)
      .post('/api/kaufland/publish/bulk')
      .send({ productIds: ['P1'] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // runId is null, but publish still succeeded
    expect(res.body.data.auditRunId).toBe(null);
    expect(res.body.data.summary.success).toBe(1);
    // appendResult should NOT have been called since runId=null
    expect(auditSpies.appendResult).not.toHaveBeenCalled();
    expect(auditSpies.finalizeRun).not.toHaveBeenCalled();
  });
});

describe('POST /api/marketplace/kaufland/publish/bulk — publishWithOnHold (0-stock flow)', () => {
  beforeEach(() => {
    auditSpies.startRun.mockClear();
    auditSpies.appendResult.mockClear();
    auditSpies.finalizeRun.mockClear();
    productStoreSpies.getProductV2.mockReset();
    kauflandApiSpies.createUnit.mockReset();
  });

  it('publishes 0-stock product when publishWithOnHold defaults to true', async () => {
    productStoreSpies.getProductV2.mockResolvedValue(buildProduct({ qty: 0 }));
    kauflandApiSpies.createUnit.mockResolvedValue({ created: true, productDataSubmitted: false, id_unit: 9003, data: {} });

    const res = await request(app)
      .post('/api/kaufland/publish/bulk')
      .send({ productIds: ['P1'] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.summary.skipped).toBe(0);
    expect(res.body.data.summary.success).toBe(1);
    // createUnit should have been invoked despite qty=0
    expect(kauflandApiSpies.createUnit).toHaveBeenCalledTimes(1);
    const resultEntry = res.body.data.results[0];
    expect(resultEntry.fixes).toBeDefined();
    expect(resultEntry.fixes.join(' ')).toMatch(/ONHOLD/);
  });

  it('skips 0-stock product when publishWithOnHold=false (legacy behaviour)', async () => {
    productStoreSpies.getProductV2.mockResolvedValue(buildProduct({ qty: 0 }));

    const res = await request(app)
      .post('/api/kaufland/publish/bulk')
      .send({ productIds: ['P1'], publishWithOnHold: false });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.summary.skipped).toBe(1);
    expect(res.body.data.summary.success).toBe(0);
    expect(kauflandApiSpies.createUnit).not.toHaveBeenCalled();
  });
});

describe('POST /api/marketplace/kaufland/publish/bulk — repair-hook on KAUFLAND_PRODUCT_DATA_PENDING', () => {
  beforeEach(() => {
    auditSpies.startRun.mockClear();
    auditSpies.appendResult.mockClear();
    auditSpies.finalizeRun.mockClear();
    productStoreSpies.getProductV2.mockReset();
    kauflandApiSpies.createUnit.mockReset();
    repairSpies.tryRepairKauflandProductData.mockReset();
  });

  it('upgrades pending→pending-repaired when repair succeeds', async () => {
    productStoreSpies.getProductV2.mockResolvedValue(buildProduct());
    const pendingErr = new Error('Produktdaten asynchron in Verarbeitung');
    pendingErr.code = 'KAUFLAND_PRODUCT_DATA_PENDING';
    pendingErr.productDataSubmitted = true;
    kauflandApiSpies.createUnit.mockRejectedValue(pendingErr);
    repairSpies.tryRepairKauflandProductData.mockResolvedValue({ repaired: true, attemptedAttributes: ['title', 'brand'] });

    const res = await request(app)
      .post('/api/kaufland/publish/bulk')
      .send({ productIds: ['P1'] });

    expect(res.status).toBe(200);
    expect(res.body.data.summary.pending).toBe(1);
    expect(res.body.data.summary.repaired).toBe(1);
    expect(res.body.data.results[0].status).toBe('pending-repaired');
    expect(res.body.data.results[0].repaired).toBe(true);
    expect(repairSpies.tryRepairKauflandProductData).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/marketplace/kaufland/publish/bulk — optimistic kauflandUnitsLive upsert', () => {
  beforeEach(() => {
    auditSpies.startRun.mockClear();
    auditSpies.appendResult.mockClear();
    auditSpies.finalizeRun.mockClear();
    productStoreSpies.getProductV2.mockReset();
    kauflandApiSpies.createUnit.mockReset();
  });

  it('writes a kauflandUnitsLive row + bumps system/kaufland-sync-state on successful create', async () => {
    productStoreSpies.getProductV2.mockResolvedValueOnce(buildProduct({ id: 'P-OPT', sku: 'SKU-OPT', qty: 5 }));
    kauflandApiSpies.createUnit.mockResolvedValueOnce({ created: true, productDataSubmitted: false, id_unit: 12345, data: {} });

    // Capture writes to firestore.collection(...).doc(...).set(...)
    const calls = [];
    const docFactory = (collectionName) => (id) => ({
      set: vi.fn(async (payload, opts) => {
        calls.push({ collection: collectionName, id, payload, opts });
      }),
      get: vi.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
    });
    const collectionSpy = vi.spyOn(firestoreModule.firestore, 'collection').mockImplementation((name) => {
      // Match the chained API surface the bulk-publish handler hits:
      // .collection(name).doc(id).set(...)
      // For other paths (e.g. audit which is mocked above), return a permissive shim.
      return {
        doc: docFactory(name),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        get: vi.fn().mockResolvedValue({ docs: [], empty: true }),
        add: vi.fn().mockResolvedValue({ id: 'mock-auto-id' }),
      };
    });

    try {
      const res = await request(app)
        .post('/api/kaufland/publish/bulk')
        .send({ productIds: ['P-OPT'], storefront: 'de' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.summary.success).toBe(1);

      // The optimistic helper writes (1) the unit row, (2) the marker doc.
      const unitWrite = calls.find(
        (c) => c.collection === 'kauflandUnitsLive' && c.id === '12345'
      );
      expect(unitWrite).toBeDefined();
      expect(unitWrite.payload).toEqual(expect.objectContaining({
        id_unit: 12345,
        id_offer: 'SKU-OPT',
        amount: 5,
        status: 'AVAILABLE',
        active: true,
        storefront: 'de',
        source: 'kaufland-publish-optimistic',
      }));
      expect(unitWrite.opts).toEqual({ merge: true });

      const markerWrite = calls.find(
        (c) => c.collection === 'system' && c.id === 'kaufland-sync-state'
      );
      expect(markerWrite).toBeDefined();
      expect(markerWrite.payload).toEqual(expect.objectContaining({
        source: 'optimistic-publish',
      }));
      expect(markerWrite.payload.lastSyncAt).toBeDefined();
    } finally {
      collectionSpy.mockRestore();
    }
  });

  it('marks 0-stock optimistic upsert as ONHOLD + active=false', async () => {
    productStoreSpies.getProductV2.mockResolvedValueOnce(buildProduct({ id: 'P-OH', sku: 'SKU-OH', qty: 0 }));
    kauflandApiSpies.createUnit.mockResolvedValueOnce({ created: true, productDataSubmitted: false, id_unit: 55555, data: {} });

    const calls = [];
    const collectionSpy = vi.spyOn(firestoreModule.firestore, 'collection').mockImplementation((name) => ({
      doc: (id) => ({
        set: vi.fn(async (payload, opts) => {
          calls.push({ collection: name, id, payload, opts });
        }),
        get: vi.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
      }),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      get: vi.fn().mockResolvedValue({ docs: [], empty: true }),
      add: vi.fn().mockResolvedValue({ id: 'mock-auto-id' }),
    }));

    try {
      const res = await request(app)
        .post('/api/kaufland/publish/bulk')
        .send({ productIds: ['P-OH'] }); // publishWithOnHold default true

      expect(res.status).toBe(200);
      const unitWrite = calls.find(
        (c) => c.collection === 'kauflandUnitsLive' && c.id === '55555'
      );
      expect(unitWrite).toBeDefined();
      expect(unitWrite.payload).toEqual(expect.objectContaining({
        id_unit: 55555,
        amount: 0,
        status: 'ONHOLD',
        active: false,
      }));
    } finally {
      collectionSpy.mockRestore();
    }
  });

  it('does NOT throw the publish response when optimistic upsert fails', async () => {
    productStoreSpies.getProductV2.mockResolvedValueOnce(buildProduct({ id: 'P-FAIL' }));
    kauflandApiSpies.createUnit.mockResolvedValueOnce({ created: true, productDataSubmitted: false, id_unit: 77777, data: {} });

    const collectionSpy = vi.spyOn(firestoreModule.firestore, 'collection').mockImplementation((name) => ({
      doc: (_id) => ({
        // Simulate a Firestore outage for the optimistic write.
        set: vi.fn().mockRejectedValue(new Error('firestore-down')),
        get: vi.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
      }),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      get: vi.fn().mockResolvedValue({ docs: [], empty: true }),
      add: vi.fn().mockResolvedValue({ id: 'mock-auto-id' }),
    }));

    try {
      const res = await request(app)
        .post('/api/kaufland/publish/bulk')
        .send({ productIds: ['P-FAIL'] });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.data.summary.success).toBe(1);
    } finally {
      collectionSpy.mockRestore();
    }
  });
});

describe('GET /api/marketplace/kaufland/publish-runs', () => {
  beforeEach(() => {
    // Reset firestore mock chain
  });

  it('returns 200 with the most recent runs', async () => {
    const fakeDocs = [
      { id: 'run-1', data: () => ({ tenantId: 'avycloud', source: 'ui-bulk', summary: { total: 5, success: 5 } }) },
      { id: 'run-2', data: () => ({ tenantId: 'avycloud', source: 'ui-bulk', summary: { total: 3, success: 2 } }) },
    ];
    const query = {
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      get: vi.fn().mockResolvedValue({ docs: fakeDocs }),
    };
    const collectionSpy = vi.spyOn(firestoreModule.firestore, 'collection').mockReturnValueOnce(query);

    const res = await request(app)
      .get('/api/kaufland/publish-runs')
      .query({ limit: 10 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toMatchObject({ id: 'run-1', tenantId: 'avycloud' });
    expect(collectionSpy).toHaveBeenCalledWith('kaufland_publish_runs');
    expect(query.orderBy).toHaveBeenCalledWith('startedAt', 'desc');
    expect(query.limit).toHaveBeenCalledWith(10);

    collectionSpy.mockRestore();
  });

  it('caps limit at 50', async () => {
    const query = {
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      get: vi.fn().mockResolvedValue({ docs: [] }),
    };
    const collectionSpy = vi.spyOn(firestoreModule.firestore, 'collection').mockReturnValueOnce(query);

    const res = await request(app)
      .get('/api/kaufland/publish-runs')
      .query({ limit: 999 });

    expect(res.status).toBe(200);
    expect(query.limit).toHaveBeenCalledWith(50);

    collectionSpy.mockRestore();
  });
});
