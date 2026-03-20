/**
 * Integration-Tests: Orders & Dashboard API (CJS)
 *
 * CJS test file (.js) — Uses require.cache patching to mock dependencies.
 * Works around Vitest 4.x's broken vi.mock() for CommonJS modules.
 *
 * Tested endpoints:
 * - GET  /api/orders              → Bestellungsliste
 * - GET  /api/dashboard/metrics   → Dashboard-Metriken
 * - GET  /api/dashboard/finance   → Finanzdaten
 * - POST /api/orders/sync         → Order-Sync triggern
 */

// globals: true in vitest.config.js makes describe, it, expect, beforeEach, vi available
const request = require('supertest');

// ─── CRITICAL: Patch GCP first, then local modules, before requiring routes ───

require('./_patchGcp');
const localMocks = require('./_patchLocalModules');
const { spies: firebaseSpies } = require('./_setupMocks');
const { createTestApp } = require('./_createApp');
const { router: ordersRouter } = require('../../routes/orders');

// ─── Test App ─────────────────────────────────────────────────────────────────

const app = createTestApp(ordersRouter);

const SAMPLE_ORDER = {
  order_id: 12345,
  status: 'new',
  date_add: 1700000000,
  currency: 'EUR',
  products: [{ name: 'Test Produkt', quantity: 1, price_brutto: 29.99 }],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/orders', () => {
  beforeEach(() => {
    firebaseSpies.listOrders?.mockReset();
  });

  it('returns 200 with orders array', async () => {
    firebaseSpies.listOrders?.mockResolvedValue([SAMPLE_ORDER]);
    const res = await request(app).get('/api/orders');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('returns 200 with empty array when no orders', async () => {
    firebaseSpies.listOrders?.mockResolvedValue([]);
    const res = await request(app).get('/api/orders');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns 500 when firestore throws', async () => {
    firebaseSpies.listOrders?.mockRejectedValue(new Error('Firestore unavailable'));
    const res = await request(app).get('/api/orders');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/dashboard/metrics', () => {
  beforeEach(() => {
    firebaseSpies.getDashboardMetrics?.mockReset();
  });

  it('returns 200 with metrics object', async () => {
    firebaseSpies.getDashboardMetrics?.mockResolvedValue({
      orders: { total: 10, new: 3 },
      revenue: { payout_brutto_window: 2500 },
      returns: { count: 1 },
    });
    const res = await request(app).get('/api/dashboard/metrics');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toHaveProperty('orders');
  });

  it('returns 500 when metrics fetch fails', async () => {
    firebaseSpies.getDashboardMetrics?.mockRejectedValue(new Error('DB error'));
    const res = await request(app).get('/api/dashboard/metrics');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/dashboard/finance', () => {
  beforeEach(() => {
    localMocks.spies.getCheckAccountBalances?.mockReset();
    localMocks.spies.getShippingCostsFromSevDesk?.mockReset();
    localMocks.spies.getEbayNetRevenueSummary?.mockReset();
  });

  it('returns 200 with finance data', async () => {
    localMocks.spies.getCheckAccountBalances?.mockResolvedValue({ accounts: [{ id: '1', name: 'Girokonto', balance: 10000, currency: 'EUR' }], total: 10000 });
    localMocks.spies.getShippingCostsFromSevDesk?.mockResolvedValue({ total: 450 });
    localMocks.spies.getEbayNetRevenueSummary?.mockResolvedValue({ net: 4800 });

    const res = await request(app).get('/api/dashboard/finance');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 200 even when external APIs fail (graceful degradation)', async () => {
    localMocks.spies.getCheckAccountBalances?.mockRejectedValue(new Error('SevDesk down'));
    localMocks.spies.getShippingCostsFromSevDesk?.mockRejectedValue(new Error('SevDesk down'));
    localMocks.spies.getEbayNetRevenueSummary?.mockResolvedValue(null);

    const res = await request(app).get('/api/dashboard/finance');
    expect(res.status).toBeLessThan(500);
  });
});

describe('POST /api/orders/sync', () => {
  beforeEach(() => {
    localMocks.spies.syncNewOrders?.mockReset();
    firebaseSpies.listOrders?.mockReset();
    firebaseSpies.listOrders?.mockResolvedValue([]);
  });

  it('returns 200 when sync succeeds', async () => {
    localMocks.spies.syncNewOrders?.mockResolvedValue({ synced: 5 });
    firebaseSpies.listOrders?.mockResolvedValue([]);
    const res = await request(app).post('/api/orders/sync');
    expect(res.status).toBe(200);
  });
});
