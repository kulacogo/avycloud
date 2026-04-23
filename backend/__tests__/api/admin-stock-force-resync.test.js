/**
 * Integration-Tests: Admin Stock Force-Resync Endpoint
 *
 * POST /api/stock/force-resync
 *   - 400 when no sku / productId given
 *   - 404 when product not found
 *   - 403 when tenant mismatch
 *   - 200 when sync succeeds
 *   - uses syncStockWithRetry from stock-sync-dispatcher
 *
 * Siehe Plan: /Users/oguz/.claude/plans/kritisches-problem-alarmstufe-rot-lazy-bumblebee.md P1.2
 */

const request = require('supertest');

require('./_patchGcp');
const { spies: localSpies } = require('./_patchLocalModules');
const { spies: firebaseSpies } = require('./_setupMocks');
const { createTestApp } = require('./_createApp');
const adminRouter = require('../../routes/admin');

const app = createTestApp(adminRouter);

const SAMPLE_PRODUCT = {
  id: 'prod-123',
  tenantId: 'trendocean',
  identification: { sku: 'SKU-9871561937' },
  inventory: { quantity: 0 },
  ops: {
    ebay: { itemId: '12345' },
    kaufland: { unitId: 'K-98765' },
  },
};

describe('POST /api/stock/force-resync', () => {
  beforeEach(() => {
    firebaseSpies.findProductByStrictIdentifier?.mockReset();
    firebaseSpies.getProduct?.mockReset();
    localSpies.syncStockWithRetry.mockReset();
    localSpies.syncStockWithRetry.mockResolvedValue({ ok: true, results: [{ channel: 'ebay', status: 'success' }] });
  });

  it('returns 400 when sku and productId are missing', async () => {
    const res = await request(app)
      .post('/api/stock/force-resync')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('returns 404 when product not found by sku', async () => {
    firebaseSpies.findProductByStrictIdentifier?.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/stock/force-resync')
      .send({ sku: 'SKU-DOES-NOT-EXIST', tenantId: 'trendocean' });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 when product not found by productId', async () => {
    firebaseSpies.getProduct?.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/stock/force-resync')
      .send({ productId: 'missing-id', tenantId: 'trendocean' });
    expect(res.status).toBe(404);
  });

  it('returns 403 when product tenantId mismatch', async () => {
    firebaseSpies.findProductByStrictIdentifier?.mockResolvedValue({
      ...SAMPLE_PRODUCT,
      tenantId: 'otherclient',
    });
    const res = await request(app)
      .post('/api/stock/force-resync')
      .send({ sku: 'SKU-9871561937', tenantId: 'trendocean' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('TENANT_MISMATCH');
    expect(localSpies.syncStockWithRetry).not.toHaveBeenCalled();
  });

  it('returns 200 and calls syncStockWithRetry on success', async () => {
    firebaseSpies.findProductByStrictIdentifier?.mockResolvedValue(SAMPLE_PRODUCT);
    const res = await request(app)
      .post('/api/stock/force-resync')
      .send({ sku: 'SKU-9871561937', tenantId: 'trendocean', reason: 'incident-2026-04-23' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.productId).toBe('prod-123');
    expect(localSpies.syncStockWithRetry).toHaveBeenCalledTimes(1);
    const call = localSpies.syncStockWithRetry.mock.calls[0][0];
    expect(call.tenantId).toBe('trendocean');
    expect(call.product).toEqual(SAMPLE_PRODUCT);
    expect(call.reason).toMatch(/^admin-force:/);
    expect(call.reason).toContain('incident-2026-04-23');
  });

  it('uses productId path when productId provided (ignores sku)', async () => {
    firebaseSpies.getProduct?.mockResolvedValue(SAMPLE_PRODUCT);
    const res = await request(app)
      .post('/api/stock/force-resync')
      .send({ productId: 'prod-123', tenantId: 'trendocean' });
    expect(res.status).toBe(200);
    expect(firebaseSpies.getProduct).toHaveBeenCalledWith('prod-123');
    expect(firebaseSpies.findProductByStrictIdentifier).not.toHaveBeenCalled();
  });

  it('returns 500 when syncStockWithRetry throws', async () => {
    firebaseSpies.findProductByStrictIdentifier?.mockResolvedValue(SAMPLE_PRODUCT);
    localSpies.syncStockWithRetry.mockRejectedValue(new Error('eBay API down'));
    const res = await request(app)
      .post('/api/stock/force-resync')
      .send({ sku: 'SKU-9871561937', tenantId: 'trendocean' });
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('eBay API down');
  });
});

describe('POST /api/stock/drain-failures', () => {
  beforeEach(() => {
    localSpies.drainStockFailures.mockReset();
    localSpies.drainStockFailures.mockResolvedValue({ total: 3, resolved: 2, stillFailing: 1, abandoned: 0 });
  });

  it('returns 200 with drain results', async () => {
    const res = await request(app)
      .post('/api/stock/drain-failures')
      .send({ tenantId: 'trendocean', limit: 50 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.resolved).toBe(2);
    expect(localSpies.drainStockFailures).toHaveBeenCalledWith({ tenantId: 'trendocean', limit: 50 });
  });

  it('caps limit at 200', async () => {
    await request(app)
      .post('/api/stock/drain-failures')
      .send({ tenantId: 'trendocean', limit: 99999 });
    expect(localSpies.drainStockFailures).toHaveBeenCalledWith({ tenantId: 'trendocean', limit: 200 });
  });

  it('returns 500 when drain throws', async () => {
    localSpies.drainStockFailures.mockRejectedValue(new Error('firestore down'));
    const res = await request(app)
      .post('/api/stock/drain-failures')
      .send({ tenantId: 'trendocean' });
    expect(res.status).toBe(500);
  });
});
