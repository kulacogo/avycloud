/**
 * Integration-Tests: Help Drawer API (CJS)
 *
 * Tests:
 * - GET /api/help/articles requires auth (401 without token)
 * - GET /api/help/articles with auth returns array > 0
 * - GET /api/help/articles/:slug returns content with frontmatter title
 * - GET /api/help/articles/<traversal> returns 400
 * - GET /api/help/articles/<missing> returns 404
 * - GET /api/help/index returns sections grouped
 *
 * Auth-mock pattern mirrors health.test.js (Firebase Admin verifyIdToken
 * rejects → 401). Help routes are pure read-only filesystem reads against
 * the real docs/kb tree, so no Firestore/Storage mocks are required.
 */

vi.mock('../../lib/firebaseAdmin', () => ({
  getAdminAuth: () => ({
    verifyIdToken: vi.fn().mockRejectedValue(Object.assign(new Error('Invalid token'), { code: 'auth/id-token-expired' })),
  }),
}));

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

const helpRouter = require('../../routes/help');
const { createTestApp } = require('./_createApp');

/**
 * Robust GET helper for the slug-validation tests.
 *
 * The help router is fully deterministic for these inputs (the slug regex is a
 * pure check), so the *only* way a `200`/`400`/`404` assertion can flake in the
 * full suite is a transient socket-level failure of supertest's per-request
 * ephemeral server under heavy parallel-worker CPU/port contention. In that
 * case superagent surfaces an error response whose `.status` is `undefined`
 * (no HTTP round-trip completed), which then fails `expect(res.status).toBe(400)`
 * even though the route itself never returned a wrong status.
 *
 * This helper retries the request a few times *only* when the response carries
 * no HTTP status (i.e. a connection error, not a real status code). It never
 * swallows or rewrites a genuine status — if the server actually answers, that
 * response is returned verbatim and the assertion stands unchanged.
 */
async function getDeterministic(app, url, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await request(app).get(url);
      if (typeof res.status === 'number') return res;
      last = res;
    } catch (err) {
      // Connection-level failure (ECONNRESET / EADDRINUSE / socket hang up):
      // not a routing decision — retry rather than fail the assertion.
      last = err && err.response ? err.response : err;
    }
  }
  return last;
}

// Auth-enforced app: real requireAuth middleware in front of helpRouter
function createAuthEnforcedApp() {
  const { requireAuth } = require('../../lib/auth');
  const app = express();
  app.use(express.json());
  app.use('/api', requireAuth, helpRouter);
  return app;
}

describe('GET /api/help/articles — auth enforcement', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const res = await request(createAuthEnforcedApp()).get('/api/help/articles');
    expect(res.status).toBe(401);
  });

  it('returns 401 when token is invalid', async () => {
    const res = await request(createAuthEnforcedApp())
      .get('/api/help/articles')
      .set('Authorization', 'Bearer invalid-token-xyz');
    expect(res.status).toBe(401);
  });
});

describe('GET /api/help/articles — list (with test user injected)', () => {
  const app = createTestApp(helpRouter);

  it('returns 200 with non-empty array', async () => {
    const res = await request(app).get('/api/help/articles');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it('every entry has slug, title, for, lastReviewed, section', async () => {
    const res = await request(app).get('/api/help/articles');
    expect(res.status).toBe(200);
    for (const article of res.body) {
      expect(typeof article.slug).toBe('string');
      expect(article.slug.length).toBeGreaterThan(0);
      expect(typeof article.title).toBe('string');
      expect(Array.isArray(article.for)).toBe(true);
      expect(typeof article.lastReviewed).toBe('string');
      expect(typeof article.section).toBe('string');
    }
  });

  it('excludes _audit-runs and _assets folders', async () => {
    const res = await request(app).get('/api/help/articles');
    expect(res.status).toBe(200);
    for (const article of res.body) {
      expect(article.slug.startsWith('_audit-runs')).toBe(false);
      expect(article.slug.startsWith('_assets')).toBe(false);
    }
  });
});

describe('GET /api/help/articles/:slug', () => {
  const app = createTestApp(helpRouter);

  it('returns content for existing article (05-pages/dashboard)', async () => {
    const res = await request(app).get('/api/help/articles/05-pages/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('05-pages/dashboard');
    expect(typeof res.body.title).toBe('string');
    expect(res.body.title.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.for)).toBe(true);
    expect(typeof res.body.lastReviewed).toBe('string');
    expect(typeof res.body.content).toBe('string');
    expect(res.body.content.length).toBeGreaterThan(0);
  });

  it('returns 400 for path-traversal attempts (URL-encoded ../../../etc/passwd)', async () => {
    // NOTE: a literal ".../../../etc/passwd" is normalized client-side by
    // supertest/superagent (per the URL spec) before the request is sent,
    // so the realistic attack vector is percent-encoded segments which Express
    // decodes only after route matching and which our slug regex must reject.
    const encoded = '%2E%2E%2F%2E%2E%2F%2E%2E%2Fetc%2Fpasswd';
    const res = await getDeterministic(app, `/api/help/articles/${encoded}`);
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe('INVALID_SLUG');
  });

  it('returns 400 for slug containing literal ".."', async () => {
    const res = await getDeterministic(app, '/api/help/articles/..%2F..%2Fetc%2Fpasswd');
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe('INVALID_SLUG');
  });

  it('returns 400 for slug pointing at excluded folder _audit-runs', async () => {
    const res = await getDeterministic(app, '/api/help/articles/_audit-runs/audit-deps-2026-05-18');
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe('INVALID_SLUG');
  });

  it('returns 400 for slug with disallowed characters', async () => {
    const res = await getDeterministic(app, '/api/help/articles/foo$bar');
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent slug', async () => {
    const res = await getDeterministic(app, '/api/help/articles/non-existent-section/non-existent-slug');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/help/index', () => {
  const app = createTestApp(helpRouter);

  it('returns sections grouped object', async () => {
    const res = await request(app).get('/api/help/index');
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe('object');
    expect(res.body).not.toBeNull();
    expect(Array.isArray(res.body)).toBe(false);

    const keys = Object.keys(res.body);
    expect(keys.length).toBeGreaterThan(0);

    for (const [section, articles] of Object.entries(res.body)) {
      expect(typeof section).toBe('string');
      expect(Array.isArray(articles)).toBe(true);
      for (const article of articles) {
        expect(typeof article.slug).toBe('string');
      }
    }
  });
});
