/**
 * Hardening Wave 1 — Webhook signature verification (HARDEN-2 + HARDEN-3)
 *
 * HARDEN-3 (Kaufland): HMAC-SHA256 mit raw body (req.rawBody capture).
 * HARDEN-2 (eBay):     x-ebay-signature header MUST be present in production.
 *
 * globals: true → describe/it/expect/vi are global
 */

'use strict';

const crypto = require('crypto');

// Hoisted state for cross-module mocks
const mockState = vi.hoisted(() => ({}));

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

function buildApp() {
  const express = require('express');
  const webhooksRouter = require('../routes/webhooks');
  const app = express();
  // Mimic the production verify-callback that captures req.rawBody for webhook routes.
  app.use(express.json({
    verify: (req, _res, buf) => {
      if (buf && buf.length && typeof req.url === 'string' && req.url.startsWith('/api/webhooks/')) {
        req.rawBody = buf;
      }
    },
  }));
  app.use('/api', webhooksRouter);
  return app;
}

// ────────────────────────────────────────────────────────────────────────────
// HARDEN-3: Kaufland HMAC verification
// ────────────────────────────────────────────────────────────────────────────

describe('HARDEN-3: Kaufland webhook HMAC verification', () => {
  let originalEnv;
  let originalSecret;

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
    originalSecret = process.env.KAUFLAND_WEBHOOK_SECRET;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    if (originalSecret === undefined) delete process.env.KAUFLAND_WEBHOOK_SECRET;
    else process.env.KAUFLAND_WEBHOOK_SECRET = originalSecret;
  });

  it('returns 503 when KAUFLAND_WEBHOOK_SECRET missing in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.KAUFLAND_WEBHOOK_SECRET = '__NULL__';

    const request = require('supertest');
    const res = await request(buildApp())
      .post('/api/webhooks/kaufland')
      .send({ event_name: 'order_new' });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe('webhook_secret_unavailable');
  });

  it('returns 401 when Shop-Signature header missing', async () => {
    process.env.NODE_ENV = 'production';
    process.env.KAUFLAND_WEBHOOK_SECRET = 'SECRET_KEY';

    const request = require('supertest');
    const res = await request(buildApp())
      .post('/api/webhooks/kaufland')
      .send({ event_name: 'order_new' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('unauthorized');
  });

  it('returns 401 when HMAC signature does not match', async () => {
    process.env.NODE_ENV = 'production';
    process.env.KAUFLAND_WEBHOOK_SECRET = 'SECRET_KEY';

    const request = require('supertest');
    const res = await request(buildApp())
      .post('/api/webhooks/kaufland')
      .set('Shop-Signature', 'wrong_signature_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      .send({ event_name: 'order_new' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_signature');
  });

  it('accepts request when HMAC matches body-only variant', async () => {
    process.env.NODE_ENV = 'production';
    process.env.KAUFLAND_WEBHOOK_SECRET = 'SECRET_KEY';

    const payload = { event_name: 'order_new', resource: '/orders/123', id_message: 'msg-1' };
    // Compute the same HMAC over the canonical JSON Express will emit. supertest
    // serializes the object verbatim — we replicate that here.
    const rawBody = JSON.stringify(payload);
    const expectedSig = crypto.createHmac('sha256', 'SECRET_KEY').update(Buffer.from(rawBody, 'utf8')).digest('hex');

    const request = require('supertest');
    const res = await request(buildApp())
      .post('/api/webhooks/kaufland')
      .set('Content-Type', 'application/json')
      .set('Shop-Signature', expectedSig)
      .set('Shop-Timestamp', '1716206400')
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('accepts request when HMAC matches composite (method+path+body+ts) variant', async () => {
    process.env.NODE_ENV = 'production';
    process.env.KAUFLAND_WEBHOOK_SECRET = 'SECRET_KEY';

    const payload = { event_name: 'order_new' };
    const rawBody = JSON.stringify(payload);
    const ts = '1716206400';
    const path = '/api/webhooks/kaufland';
    const composite = Buffer.concat([
      Buffer.from(`POST\n${path}\n`, 'utf8'),
      Buffer.from(rawBody, 'utf8'),
      Buffer.from(`\n${ts}`, 'utf8'),
    ]);
    const expectedSig = crypto.createHmac('sha256', 'SECRET_KEY').update(composite).digest('hex');

    const request = require('supertest');
    const res = await request(buildApp())
      .post('/api/webhooks/kaufland')
      .set('Content-Type', 'application/json')
      .set('Shop-Signature', expectedSig)
      .set('Shop-Timestamp', ts)
      .send(rawBody);

    expect(res.status).toBe(200);
  });

  it('passes in non-production when secret is missing (dev convenience)', async () => {
    process.env.NODE_ENV = 'development';
    process.env.KAUFLAND_WEBHOOK_SECRET = '__NULL__';

    const request = require('supertest');
    const res = await request(buildApp())
      .post('/api/webhooks/kaufland')
      .send({ event_name: 'order_new' });

    expect(res.status).toBe(200);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// HARDEN-2: eBay POST signature header required
// ────────────────────────────────────────────────────────────────────────────

describe('HARDEN-2: eBay webhook signature header gate', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('returns 412 in production when x-ebay-signature header missing', async () => {
    process.env.NODE_ENV = 'production';

    const request = require('supertest');
    const res = await request(buildApp())
      .post('/api/webhooks/ebay')
      .send({ metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION' } });

    expect(res.status).toBe(412);
    expect(res.body.error).toMatch(/missing_signature/);
  });

  it('passes in non-production when header missing (dev convenience)', async () => {
    process.env.NODE_ENV = 'development';

    const request = require('supertest');
    const res = await request(buildApp())
      .post('/api/webhooks/ebay')
      .send({ metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION' } });

    expect(res.status).toBe(200);
  });

  it('accepts request when x-ebay-signature header is present (phase 1)', async () => {
    process.env.NODE_ENV = 'production';

    const request = require('supertest');
    const res = await request(buildApp())
      .post('/api/webhooks/ebay')
      .set('x-ebay-signature', 'eyJhbGciOiJFQ0RTQS1QMjU2In0=.placeholder-base64-signature')
      .send({ metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION' } });

    expect(res.status).toBe(200);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Raw-body capture: verify-callback in express.json
// ────────────────────────────────────────────────────────────────────────────

describe('Raw-body capture for /api/webhooks/*', () => {
  it('attaches req.rawBody only for webhook paths', async () => {
    const express = require('express');
    const observed = { rawBody: null, path: null };

    const app = express();
    app.use(express.json({
      verify: (req, _res, buf) => {
        if (buf && buf.length && typeof req.url === 'string' && req.url.startsWith('/api/webhooks/')) {
          req.rawBody = buf;
        }
      },
    }));
    app.post('/api/webhooks/test', (req, res) => {
      observed.rawBody = req.rawBody;
      observed.path = req.path;
      res.json({ ok: true, hasRaw: Boolean(req.rawBody) });
    });
    app.post('/api/products/test', (req, res) => {
      observed.rawBody = req.rawBody;
      res.json({ ok: true, hasRaw: Boolean(req.rawBody) });
    });

    const request = require('supertest');

    // Webhook path → rawBody set
    const a = await request(app).post('/api/webhooks/test').send({ foo: 'bar' });
    expect(a.body.hasRaw).toBe(true);
    expect(Buffer.isBuffer(observed.rawBody)).toBe(true);
    expect(observed.rawBody.toString('utf8')).toContain('"foo":"bar"');

    // Non-webhook path → rawBody NOT set
    const b = await request(app).post('/api/products/test').send({ baz: 'qux' });
    expect(b.body.hasRaw).toBe(false);
  });
});
