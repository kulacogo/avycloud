/**
 * Tests: Health-Endpoints + Auth-Enforcement
 *
 * Testet:
 * - GET /health → 200 ohne Auth (public)
 * - GET /ready  → 200 ohne Auth (public)
 * - GET /api/*  → 401 ohne Authorization-Header
 * - GET /api/*  → 401 mit ungültigem Token
 */

// Firebase Admin mocken bevor auth.js es importiert
vi.mock('../../lib/firebaseAdmin', () => ({
  getAdminAuth: () => ({
    verifyIdToken: vi.fn().mockRejectedValue(Object.assign(new Error('Invalid token'), { code: 'auth/id-token-expired' })),
  }),
}));

// Firestore mocken damit rbac.js laden kann
vi.mock('@google-cloud/firestore', () => {
  const col = () => ({ doc: () => ({ get: vi.fn().mockResolvedValue({ exists: false, data: () => ({}) }) }) });
  const MockFirestore = function () { this.collection = col; };
  MockFirestore.FieldValue = { serverTimestamp: () => null, increment: (n) => n, delete: () => null };
  MockFirestore.Timestamp = { now: () => ({ seconds: 0, nanoseconds: 0 }), fromDate: (d) => d };
  return { Firestore: MockFirestore, FieldValue: MockFirestore.FieldValue, Timestamp: MockFirestore.Timestamp };
});

vi.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: vi.fn(),
  credential: { applicationDefault: vi.fn() },
  auth: () => ({ verifyIdToken: vi.fn().mockRejectedValue(new Error('Invalid token')) }),
}));

const request = require('supertest');
const express = require('express');

// Health-Routes direkt nachbauen (wie in index.js) — keine Auth nötig
function createHealthApp() {
  const app = express();
  app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
  app.get('/ready', (req, res) => res.json({ status: 'ready' }));
  return app;
}

// Auth-Enforcement-App: echte requireAuth Middleware
function createAuthEnforcedApp() {
  const { requireAuth } = require('../../lib/auth');
  const app = express();
  app.use(express.json());
  app.use('/api', requireAuth, (req, res) => res.json({ ok: true, uid: req.user?.uid }));
  return app;
}

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const res = await request(createHealthApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });
});

describe('GET /ready', () => {
  it('returns 200 with status ready', async () => {
    const res = await request(createHealthApp()).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });
});

describe('Auth enforcement', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await request(createAuthEnforcedApp()).get('/api/anything');
    expect(res.status).toBe(401);
  });

  it('returns 401 when token is invalid', async () => {
    const res = await request(createAuthEnforcedApp())
      .get('/api/anything')
      .set('Authorization', 'Bearer invalid-token-xyz');
    expect(res.status).toBe(401);
  });

  it('returns 401 with Bearer prefix missing', async () => {
    const res = await request(createAuthEnforcedApp())
      .get('/api/anything')
      .set('Authorization', 'valid-token-without-bearer');
    expect(res.status).toBe(401);
  });
});
