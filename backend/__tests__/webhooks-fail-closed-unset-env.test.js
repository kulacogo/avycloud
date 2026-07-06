/**
 * Webhook-Guards müssen fail-closed sein, wenn NODE_ENV NICHT gesetzt ist.
 *
 * In Cloud Run ist NODE_ENV nicht gesetzt (siehe lib/stock-lock.js + Memory
 * infra-node-env-unset-cloudrun). Ein Guard mit `NODE_ENV === 'production'`
 * war dort immer false — fehlendes Secret/Signatur wurde durchgewunken.
 * Erwartung seit Fix: alles außer test/development gilt als Production.
 */

'use strict';

vi.mock('../lib/firestore', () => {
  const collectionStub = () => ({
    where: () => ({ get: vi.fn().mockResolvedValue({ empty: true, docs: [] }) }),
    doc: () => ({ id: 'mock', get: vi.fn().mockResolvedValue({ exists: false }) }),
    add: vi.fn().mockResolvedValue({ id: 'evt-mock' }),
  });
  return {
    firestore: { collection: collectionStub },
    getDb: () => ({ collection: collectionStub }),
  };
});

vi.mock('../services/order-state-machine', () => ({
  transitionOrder: vi.fn().mockResolvedValue({ ok: true }),
  ORDER_STATUSES: {},
}));

vi.mock('../services/sync-event-bus', () => ({
  emitSyncEvent: vi.fn(),
}));

// integration-store + secret-values werden im Handler lazy-required —
// vi.mock() fängt CJS require() nicht zuverlässig ab, daher require.cache-Patch.
function patchCjsModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: mockExports,
    children: [],
    paths: [],
  };
}

patchCjsModule('../services/integration-store.js', {
  getIntegrationSecret: vi.fn().mockResolvedValue(null),
  resolveProviderCredentials: vi.fn().mockResolvedValue(null),
});

patchCjsModule('../lib/secret-values.js', {
  getSecretValue: vi.fn().mockResolvedValue(null),
});

function buildApp() {
  const express = require('express');
  const webhooksRouter = require('../routes/webhooks');
  const app = express();
  app.use(express.json());
  app.use('/api', webhooksRouter);
  return app;
}

describe('Webhook fail-closed bei ungesetztem NODE_ENV (Cloud-Run-Realität)', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV; // Cloud Run: Variable existiert nicht
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnv;
  });

  it('SendCloud: 503 wenn Secret fehlt', async () => {
    const request = require('supertest');
    const res = await request(buildApp())
      .post('/api/webhooks/sendcloud')
      .send({ parcel_id: 123, status: { id: 11 } });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('webhook_secret_unavailable');
  });

  it('Kaufland: 503 wenn Secret fehlt', async () => {
    const request = require('supertest');
    const res = await request(buildApp())
      .post('/api/webhooks/kaufland')
      .send({ event_name: 'order_new' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('webhook_secret_unavailable');
  });

  it('eBay: 412 wenn Signatur-Header fehlt', async () => {
    const request = require('supertest');
    const res = await request(buildApp())
      .post('/api/webhooks/ebay')
      .send({ metadata: { topic: 'ITEM_SOLD' } });
    expect(res.status).toBe(412);
  });

  it('test-Env bleibt permissiv (kein Block ohne Secret)', async () => {
    process.env.NODE_ENV = 'test';
    const request = require('supertest');
    const res = await request(buildApp())
      .post('/api/webhooks/sendcloud')
      .send({ parcel_id: 123, status: { id: 11 } });
    expect(res.status).toBe(200);
  });
});
