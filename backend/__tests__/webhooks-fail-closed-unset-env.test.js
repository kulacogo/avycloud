/**
 * Webhook-Guards müssen fail-closed sein, wenn NODE_ENV NICHT gesetzt ist.
 *
 * In Cloud Run ist NODE_ENV nicht gesetzt (siehe lib/stock-lock.js + Memory
 * infra-node-env-unset-cloudrun). Ein Guard mit `NODE_ENV === 'production'`
 * war dort immer false — fehlendes Secret/Signatur wurde durchgewunken.
 * Erwartung seit Fix: alles außer test/development gilt als Production.
 */

'use strict';

// Die Route konstruiert den SDK-Client direkt, nicht über lib/firestore.
// Alle CJS-Abhängigkeiten vor dem Laden der Route ersetzen: kein echter
// Firestore-/Secret-Zugriff, auch im permissiven test/development-Pfad.
const originalCacheEntries = new Map();
function patchCjsModule(modulePath, mockExports) {
  const resolvedPath = require.resolve(modulePath);
  originalCacheEntries.set(resolvedPath, require.cache[resolvedPath]);
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: mockExports,
    children: [],
    paths: [],
  };
}

const queryGet = vi.fn().mockResolvedValue({ empty: true, docs: [] });
const query = {
  where: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  get: queryGet,
};
const collection = vi.fn(() => query);
patchCjsModule('@google-cloud/firestore', {
  Firestore: class {
    collection = collection;
  },
});
patchCjsModule('../services/order-state-machine.js', {
  transitionOrder: vi.fn().mockResolvedValue({ ok: true }),
  ORDER_STATUSES: {},
});
patchCjsModule('../services/sync-event-bus.js', {
  emitSyncEvent: vi.fn(),
});

patchCjsModule('../services/integration-store.js', {
  getIntegrationSecret: vi.fn().mockResolvedValue(null),
  resolveProviderCredentials: vi.fn().mockResolvedValue(null),
});

patchCjsModule('../lib/secret-values.js', {
  getSecretValue: vi.fn().mockResolvedValue(null),
});

const routerPath = require.resolve('../routes/webhooks');
originalCacheEntries.set(routerPath, require.cache[routerPath]);
delete require.cache[routerPath];

afterAll(() => {
  for (const [modulePath, original] of originalCacheEntries) {
    if (original) require.cache[modulePath] = original;
    else delete require.cache[modulePath];
  }
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
    vi.clearAllMocks();
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
    expect(collection).not.toHaveBeenCalled();
  });

  it('Kaufland: 503 wenn Secret fehlt', async () => {
    const request = require('supertest');
    const res = await request(buildApp())
      .post('/api/webhooks/kaufland')
      .send({ event_name: 'order_new' });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('webhook_secret_unavailable');
    expect(collection).not.toHaveBeenCalled();
  });

  it('eBay: 412 wenn Signatur-Header fehlt', async () => {
    const request = require('supertest');
    const res = await request(buildApp())
      .post('/api/webhooks/ebay')
      .send({ metadata: { topic: 'ITEM_SOLD' } });
    expect(res.status).toBe(412);
    expect(collection).not.toHaveBeenCalled();
  });

  it('test-Env bleibt permissiv (kein Block ohne Secret)', async () => {
    process.env.NODE_ENV = 'test';
    const request = require('supertest');
    const res = await request(buildApp())
      .post('/api/webhooks/sendcloud')
      .send({ parcel_id: 123, status: { id: 11 } });
    expect(res.status).toBe(200);
    expect(collection).toHaveBeenCalledWith('shipments');
    expect(query.where).toHaveBeenCalledWith('sendcloudParcelId', '==', 123);
    expect(queryGet).toHaveBeenCalledTimes(1);
  });
});
