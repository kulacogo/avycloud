'use strict';

/**
 * D.0b — Tenant-Propagation Runtime-Coverage.
 *
 * Complements the lexical migration tests (routes-products-tenant-migration,
 * admin-bulk-actions-tenant-migration, …) by exercising the actual Express
 * request lifecycle and asserting that `tenantId` reaches the downstream
 * Firestore helper at runtime.
 *
 * Pattern (Vitest 4.x, CJS):
 *   1. _patchGcp        — neutralise Firestore/Storage SDK at the npm layer.
 *   2. _patchLocalModules — replace local module require.cache (rbac, …).
 *   3. _setupMocks      — spy on lib/firestore.js exports.
 *   4. Build a per-test Express app with an injectable `req.user`.
 *   5. Fire requests via supertest and assert spy.calls reflect the
 *      tenantId from the request.
 *
 * Tested behaviours:
 *   - GET /api/products with req.user.tenantId='avycloud'
 *       → getAllProductsForTenant('avycloud')
 *   - GET /api/products with req.user but no tenantId
 *       → getAllProductsForTenant('default')
 *   - GET /api/products without req.user at all
 *       → getAllProductsForTenant('default') (route falls back, never 500)
 *   - POST /api/admin/bulk/run with tenantId in body
 *       → admin-bulk-jobs.createJob receives a payload with tenantId.
 */

const request = require('supertest');
const express = require('express');

require('../api/_patchGcp');
const { spies: localSpies } = require('../api/_patchLocalModules');
const { spies: firebaseSpies } = require('../api/_setupMocks');
const { errorHandler } = require('../../lib/error-handler');

// Load route modules AFTER all patching is complete.
const { router: productsRouter } = require('../../routes/products');
const adminRouter = require('../../routes/admin');

// Build an Express app where each request can inject its own user via
// `req.headers['x-test-user']` (JSON-encoded). Falls back to "no user".
function buildAppWithInjectableUser(router, mountAt = '/api') {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use((req, _res, next) => {
    const raw = req.headers['x-test-user'];
    if (raw) {
      try {
        req.user = JSON.parse(raw);
      } catch (_e) {
        // ignore malformed header → no user
      }
    }
    next();
  });
  app.use(mountAt, router);
  app.use(errorHandler);
  return app;
}

function userHeader(user) {
  return { 'x-test-user': JSON.stringify(user) };
}

// ───────────────────────────────────────────────────────────────────────────
// GET /api/products — tenantId propagation
// ───────────────────────────────────────────────────────────────────────────

describe('D.0b runtime — GET /api/products propagates req.user.tenantId', () => {
  const app = buildAppWithInjectableUser(productsRouter);

  beforeEach(() => {
    firebaseSpies.getAllProductsForTenant?.mockReset();
    firebaseSpies.getAllProductsForTenant?.mockResolvedValue([]);
    // The route also calls these helpers in parallel; keep them harmless.
    firebaseSpies.listOrdersByStatus?.mockResolvedValue([]);
  });

  it('passes tenantId=avycloud when req.user.tenantId is "avycloud"', async () => {
    const res = await request(app)
      .get('/api/products')
      .set(userHeader({ uid: 'u1', email: 'a@x', tenantId: 'avycloud' }));

    expect(res.status).toBe(200);
    expect(firebaseSpies.getAllProductsForTenant).toHaveBeenCalledTimes(1);
    expect(firebaseSpies.getAllProductsForTenant).toHaveBeenCalledWith('avycloud');
  });

  it('passes tenantId=trendocean when req.user.tenantId is "trendocean"', async () => {
    const res = await request(app)
      .get('/api/products')
      .set(userHeader({ uid: 'u2', email: 'b@x', tenantId: 'trendocean' }));

    expect(res.status).toBe(200);
    expect(firebaseSpies.getAllProductsForTenant).toHaveBeenCalledWith('trendocean');
  });

  it('falls back to tenantId="default" when req.user has no tenantId', async () => {
    const res = await request(app)
      .get('/api/products')
      .set(userHeader({ uid: 'u3', email: 'c@x' }));

    expect(res.status).toBe(200);
    expect(firebaseSpies.getAllProductsForTenant).toHaveBeenCalledWith('default');
  });

  it('falls back to tenantId="default" when req.user is missing entirely', async () => {
    // requirePermission is mocked to pass through (see _patchLocalModules.js)
    // → route handler runs and uses optional-chaining fallback.
    const res = await request(app).get('/api/products');

    expect(res.status).toBe(200);
    expect(firebaseSpies.getAllProductsForTenant).toHaveBeenCalledWith('default');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /api/products/bulk-improve — second migrated call-site
// ───────────────────────────────────────────────────────────────────────────

describe('D.0b runtime — POST /api/products/bulk-improve propagates tenantId', () => {
  const app = buildAppWithInjectableUser(productsRouter);

  beforeEach(() => {
    firebaseSpies.getAllProductsForTenant?.mockReset();
    firebaseSpies.getAllProductsForTenant?.mockResolvedValue([]);
  });

  it('passes req.user.tenantId straight into getAllProductsForTenant', async () => {
    const res = await request(app)
      .post('/api/products/bulk-improve')
      .set(userHeader({ uid: 'u1', email: 'a@x', tenantId: 'avycloud' }))
      .send({});

    // Empty product list → handler should still respond 200 with summary.
    expect([200, 202]).toContain(res.status);
    expect(firebaseSpies.getAllProductsForTenant).toHaveBeenCalledWith('avycloud');
  });

  it('falls back to "default" when tenantId is absent', async () => {
    const res = await request(app)
      .post('/api/products/bulk-improve')
      .set(userHeader({ uid: 'u1', email: 'a@x' }))
      .send({});

    expect([200, 202]).toContain(res.status);
    expect(firebaseSpies.getAllProductsForTenant).toHaveBeenCalledWith('default');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /api/admin/bulk/run — tenantId carried into background-job payload
// ───────────────────────────────────────────────────────────────────────────

describe('D.0b runtime — POST /api/admin/bulk/run threads tenantId into payload', () => {
  const app = buildAppWithInjectableUser(adminRouter, '/api/admin');

  beforeEach(() => {
    localSpies.adminBulkJobsCreateJob.mockReset();
    localSpies.adminBulkJobsCreateJob.mockResolvedValue({ id: 'job-runtime-test' });
    localSpies.enqueueAdminBulkJob.mockReset();
    localSpies.enqueueAdminBulkJob.mockResolvedValue({ jobId: 'job-runtime-test' });
  });

  it('uses body.tenantId verbatim when present in the request body', async () => {
    const res = await request(app)
      .post('/api/admin/bulk/run')
      .set(userHeader({ uid: 'admin', email: 'admin@x', tenantId: 'fallback-from-user', isAdmin: true }))
      .send({ action: 'recategorize_v2', tenantId: 'avycloud', apply: false });

    expect(res.status).toBe(202);
    expect(localSpies.adminBulkJobsCreateJob).toHaveBeenCalledTimes(1);
    const callArgs = localSpies.adminBulkJobsCreateJob.mock.calls[0][0];
    expect(callArgs).toBeTruthy();
    expect(callArgs.payload).toBeTruthy();
    // body.tenantId wins over req.user.tenantId per route contract.
    expect(callArgs.payload.tenantId).toBe('avycloud');
    expect(callArgs.payload.action).toBe('recategorize_v2');
  });

  it('falls back to req.user.tenantId when body.tenantId is omitted', async () => {
    const res = await request(app)
      .post('/api/admin/bulk/run')
      .set(userHeader({ uid: 'admin', email: 'admin@x', tenantId: 'trendocean', isAdmin: true }))
      .send({ action: 'recategorize_v2', apply: false });

    expect(res.status).toBe(202);
    const callArgs = localSpies.adminBulkJobsCreateJob.mock.calls[0][0];
    expect(callArgs.payload.tenantId).toBe('trendocean');
  });

  it('falls back to "default" when neither body.tenantId nor req.user.tenantId is set', async () => {
    const res = await request(app)
      .post('/api/admin/bulk/run')
      .set(userHeader({ uid: 'admin', email: 'admin@x', isAdmin: true }))
      .send({ action: 'recategorize_v2', apply: false });

    expect(res.status).toBe(202);
    const callArgs = localSpies.adminBulkJobsCreateJob.mock.calls[0][0];
    expect(callArgs.payload.tenantId).toBe('default');
  });

  it('rejects empty-string tenantId in body and falls through to user/default', async () => {
    const res = await request(app)
      .post('/api/admin/bulk/run')
      .set(userHeader({ uid: 'admin', email: 'admin@x', tenantId: 'trendocean', isAdmin: true }))
      .send({ action: 'recategorize_v2', tenantId: '   ', apply: false });

    expect(res.status).toBe(202);
    const callArgs = localSpies.adminBulkJobsCreateJob.mock.calls[0][0];
    // Whitespace-only body.tenantId should not override; route falls back to
    // req.user.tenantId.
    expect(callArgs.payload.tenantId).toBe('trendocean');
  });
});
