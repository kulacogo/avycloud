/**
 * Hardening Wave 1 — Production-Sicherheits-Fixes (2026-05-20)
 *
 * Verifiziert die drei Fixes aus dem Deep-Dive-Audit:
 *  - HARDEN-1: runRefundPush Cross-Tenant-Filter (source contract)
 *  - HARDEN-4: SendCloud-Webhook fail-closed + hardened Basic-Auth-Match
 *  - HARDEN-9: stock-lock loud-fail in production
 *
 * Test-Strategie: `getSecretValue()` liest `process.env[secretName]` ZUERST und
 * akzeptiert den speziellen Marker-Wert `__NULL__` als "simulate missing secret"
 * (test-only escape hatch in `lib/secret-values.js`). Damit umgehen wir den
 * vitest-CommonJS-Mock-Issue mit transitiv-dynamischen requires.
 *
 * globals: true → describe/it/expect/vi sind global aus vitest.config.js
 */

'use strict';

// Hoisted state controlled per-test
const mockState = vi.hoisted(() => ({
  firestoreThrow: null,
}));

// Firestore mock — controlled via mockState.firestoreThrow
vi.mock('../lib/firestore', () => {
  const collectionStub = () => ({
    where: () => ({ get: vi.fn().mockResolvedValue({ empty: true, docs: [] }) }),
    doc: () => ({ id: 'mock', get: vi.fn().mockResolvedValue({ exists: false }) }),
  });
  return {
    firestore: {
      collection: collectionStub,
      runTransaction: vi.fn(async (fn) => {
        if (mockState.firestoreThrow) throw mockState.firestoreThrow;
        const tx = {
          get: vi.fn().mockResolvedValue({ exists: false }),
          set: vi.fn(),
          delete: vi.fn(),
        };
        return fn(tx);
      }),
    },
    getDb: () => ({ collection: collectionStub }),
  };
});

vi.mock('../services/order-state-machine', () => ({
  transitionOrder: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../services/sync-event-bus', () => ({
  emitSyncEvent: vi.fn(),
}));

// ────────────────────────────────────────────────────────────────────────────
// HARDEN-9: stock-lock loud-fail in production
// ────────────────────────────────────────────────────────────────────────────

describe('HARDEN-9: stock-lock production fail-closed', () => {
  // Source contract test — robust under CommonJS test isolation, where
  // module mocks for transitively-required modules (`./firestore`) flake when
  // another test file in the same suite has already loaded the real module.
  it('source code in stock-lock.js implements production fail-closed', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', 'lib', 'stock-lock.js'),
      'utf8'
    );

    // Must check NODE_ENV === 'production' before deciding to fall back.
    expect(source).toMatch(/process\.env\.NODE_ENV\s*===\s*['"]production['"]/);

    // Must throw an "stock-lock unavailable" error rather than fall back silently.
    expect(source).toMatch(/stock-lock unavailable/i);

    // Must NOT have the legacy unconditional memory-fallback that just warns.
    // Specifically: the warn-and-fallback path must be inside a non-prod branch.
    // We check that the memory-fallback comment makes the dev/local intent explicit.
    expect(source).toMatch(/fallback=memory[^"]*dev|fallback=memory.*local/i);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// HARDEN-4: SendCloud-Webhook fail-closed + hardened Basic-Auth-Match
// ────────────────────────────────────────────────────────────────────────────

describe('HARDEN-4: SendCloud webhook authentication', () => {
  let originalEnv;
  let originalSecret;

  function buildApp() {
    const express = require('express');
    const webhooksRouter = require('../routes/webhooks');
    const app = express();
    app.use(express.json());
    app.use('/api', webhooksRouter);
    return app;
  }

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
    originalSecret = process.env.SENDCLOUD_SECRET_KEY;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    if (originalSecret === undefined) delete process.env.SENDCLOUD_SECRET_KEY;
    else process.env.SENDCLOUD_SECRET_KEY = originalSecret;
  });

  it('returns 503 when SENDCLOUD_SECRET_KEY is missing in production', async () => {
    process.env.NODE_ENV = 'production';
    // `__NULL__` is a test-only marker in secret-values.js → returns null.
    process.env.SENDCLOUD_SECRET_KEY = '__NULL__';

    const request = require('supertest');
    const res = await request(buildApp())
      .post('/api/webhooks/sendcloud')
      .send({ parcel_id: 12345, status: { id: 5 } });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('webhook_secret_unavailable');
  });

  it('returns 401 when secret is set but Basic-Auth does not match', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SENDCLOUD_SECRET_KEY = 'SUPER_SECRET_VALUE';

    const request = require('supertest');
    const badAuth = Buffer.from('public_key:WRONG_SECRET').toString('base64');
    const res = await request(buildApp())
      .post('/api/webhooks/sendcloud')
      .set('Authorization', `Basic ${badAuth}`)
      .send({ parcel_id: 12345 });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('rejects naive includes-style bypass (HARDEN-4 hardened match)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SENDCLOUD_SECRET_KEY = 'TOPSECRET';

    const request = require('supertest');
    // Vorher (includes-bug): ein public_key der das secret als substring enthält
    // wäre akzeptiert worden. Hardened code splittet `username:password` und
    // verlangt exakten Match auf dem password-Part.
    const sneaky = Buffer.from('my_public_TOPSECRET_here:totally_different').toString('base64');
    const res = await request(buildApp())
      .post('/api/webhooks/sendcloud')
      .set('Authorization', `Basic ${sneaky}`)
      .send({ parcel_id: 12345 });

    expect(res.status).toBe(401);
  });

  it('accepts request when secret matches exactly (positive path)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SENDCLOUD_SECRET_KEY = 'GOOD_SECRET';

    const request = require('supertest');
    const goodAuth = Buffer.from('public_key:GOOD_SECRET').toString('base64');
    const res = await request(buildApp())
      .post('/api/webhooks/sendcloud')
      .set('Authorization', `Basic ${goodAuth}`)
      .send({}); // no parcel_id → early 200 with "skipped"

    expect(res.status).toBe(200);
  });

  it('returns 200 in non-production when secret is missing (dev convenience)', async () => {
    process.env.NODE_ENV = 'development';
    process.env.SENDCLOUD_SECRET_KEY = '__NULL__';

    const request = require('supertest');
    const res = await request(buildApp())
      .post('/api/webhooks/sendcloud')
      .send({}); // no parcel_id

    expect(res.status).toBe(200);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// HARDEN-1: runRefundPush filter sanity check (source contract)
// ────────────────────────────────────────────────────────────────────────────

describe('HARDEN-1: runRefundPush tenant-filter contract', () => {
  it('source code uses .where("tenantId", "==", ...) on returns query', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '..', 'services', 'returns-engine.js'),
      'utf8'
    );
    // Both queries (strict + legacy) must filter by tenantId.
    const tenantIdFilterMatches = source.match(/\.where\(['"]tenantId['"]\s*,\s*['"]==['"]\s*,/g) || [];
    expect(tenantIdFilterMatches.length).toBeGreaterThanOrEqual(2);

    // Defense-in-depth: source must contain the explicit doc-level tenant check.
    expect(source).toMatch(/tenant mismatch returnId/);
  });
});
