/**
 * Integration-Tests: Admin Identify-Runs Audit Endpoint (Plan D.1)
 *
 * GET /api/admin/identify-runs
 *   - tenantId comes from req.user (TEST_USER → 'default' if undefined)
 *   - filter by confidence range
 *   - filter by pipeline ('v3' | 'v4' | 'all')
 *   - pagination (page, pageSize cap 100)
 *
 * Tests the service via direct unit-test-style assertions + the route's
 * integration with the mocked service.
 *
 * CJS test — uses require.cache-Patching (kein vi.mock für CJS).
 */

const request = require('supertest');
const path = require('path');

require('./_patchGcp');

// Helper: patch a local module in require.cache (matches chat-v3-integration.test.js)
function patchLocalModule(modulePath, mockExports) {
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

// Mock the identify-runs-dashboard service BEFORE the route loads.
const listIdentifyRunsSpy = vi.fn();
patchLocalModule(path.resolve(__dirname, '../../services/identify-runs-dashboard.js'), {
  listIdentifyRuns: listIdentifyRunsSpy,
});

require('./_patchLocalModules');
require('./_setupMocks');
const { createTestApp } = require('./_createApp');
const adminRouter = require('../../routes/admin');

const app = createTestApp(adminRouter);

const RUN_V4 = {
  pipeline: 'v4',
  productId: 'p-001',
  sku: 'SKU-001',
  checkedAtIso: '2026-05-01T10:00:00.000Z',
  confidence: { aggregate: 0.92, readyForPublish: true, missingCritical: [] },
  workerSummary: {
    identity: { confidence: 0.95, ok: true, retriesRequested: 0, sources: ['ebay_catalog'] },
    category: { confidence: 0.88, ok: true, retriesRequested: 0, sources: ['gemini'] },
  },
  criticScore: 0.85,
  cassiniSubscores: { overall: 0.8, title: 0.8, description: 0.8, image: 0.7, specifics: 0.9, compliance: 0.9 },
  issues: [],
  conflicts: [],
};

const RUN_V3 = {
  pipeline: 'v3',
  productId: 'p-002',
  sku: 'SKU-002',
  checkedAtIso: '2026-04-29T12:00:00.000Z',
  confidence: { aggregate: 0.55, readyForPublish: null, missingCritical: [] },
  workerSummary: {
    identity: { confidence: 0.7, ok: null, retriesRequested: null, sources: [] },
  },
  criticScore: 0.6,
  cassiniSubscores: null,
  issues: [],
  conflicts: [],
};

describe('GET /api/admin/identify-runs', () => {
  beforeEach(() => {
    listIdentifyRunsSpy.mockReset();
  });

  it('returns 200 with empty list when service returns empty', async () => {
    listIdentifyRunsSpy.mockResolvedValue({ runs: [], total: 0, page: 1, pageSize: 50 });
    const res = await request(app).get('/api/identify-runs');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.runs).toEqual([]);
    expect(res.body.data.total).toBe(0);
    expect(listIdentifyRunsSpy).toHaveBeenCalledTimes(1);
    const args = listIdentifyRunsSpy.mock.calls[0][0];
    // tenantId defaults to 'default' (TEST_USER has no tenantId)
    expect(args.tenantId).toBe('default');
  });

  it('returns 400 (via thrown statusCode=400) when service rejects missing tenantId', async () => {
    const err = new Error('tenantId required');
    err.statusCode = 400;
    listIdentifyRunsSpy.mockRejectedValue(err);
    const res = await request(app).get('/api/identify-runs');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.message).toBe('tenantId required');
  });

  it('passes confidence_min/confidence_max filters through to service', async () => {
    listIdentifyRunsSpy.mockResolvedValue({ runs: [RUN_V4], total: 1, page: 1, pageSize: 50 });
    const res = await request(app)
      .get('/api/identify-runs')
      .query({ confidence_min: 0.7, confidence_max: 0.95 });
    expect(res.status).toBe(200);
    const args = listIdentifyRunsSpy.mock.calls[0][0];
    expect(args.confidence_min).toBe('0.7');
    expect(args.confidence_max).toBe('0.95');
    expect(res.body.data.runs).toHaveLength(1);
    expect(res.body.data.runs[0].pipeline).toBe('v4');
  });

  it('returns V3 and V4 runs uniformly via the mapper layer (pipeline=all)', async () => {
    listIdentifyRunsSpy.mockResolvedValue({
      runs: [RUN_V4, RUN_V3],
      total: 2,
      page: 1,
      pageSize: 50,
    });
    const res = await request(app)
      .get('/api/identify-runs')
      .query({ pipeline: 'all' });
    expect(res.status).toBe(200);
    expect(res.body.data.runs).toHaveLength(2);
    const pipelines = res.body.data.runs.map((r) => r.pipeline).sort();
    expect(pipelines).toEqual(['v3', 'v4']);
    // Worker-summary normalized for both pipelines
    for (const r of res.body.data.runs) {
      expect(r.workerSummary).toBeDefined();
      expect(typeof r.workerSummary).toBe('object');
    }
    const args = listIdentifyRunsSpy.mock.calls[0][0];
    expect(args.pipeline).toBe('all');
  });

  it('passes pagination params (page, pageSize) through', async () => {
    listIdentifyRunsSpy.mockResolvedValue({ runs: [], total: 250, page: 3, pageSize: 50 });
    const res = await request(app)
      .get('/api/identify-runs')
      .query({ page: 3, pageSize: 50 });
    expect(res.status).toBe(200);
    expect(res.body.data.page).toBe(3);
    expect(res.body.data.total).toBe(250);
    const args = listIdentifyRunsSpy.mock.calls[0][0];
    expect(args.page).toBe('3');
    expect(args.pageSize).toBe('50');
  });
});

// ─── Service-level test: mapper-layer for V3/V4 ────────────────────────────────
describe('listIdentifyRuns mapper-layer (direct service test)', () => {
  // Reset modules so we get the REAL service (not the spy), and re-load firestore mock.
  let mapProductToRun;

  beforeAll(() => {
    // Drop the spy from the cache and re-require the real implementation.
    const resolved = require.resolve('../../services/identify-runs-dashboard.js');
    delete require.cache[resolved];
    const mod = require('../../services/identify-runs-dashboard');
    mapProductToRun = mod._internal.mapProductToRun;
  });

  it('maps an identify_v4 product to pipeline=v4 with confidence aggregate + worker summary', () => {
    const product = {
      id: 'p-v4',
      identification: { sku: 'SKU-v4' },
      identifyCheckedAtIso: '2026-05-02T08:00:00.000Z',
      ops: {
        data_quality: {
          identify_v4: {
            checked_at_iso: '2026-05-02T08:00:00.000Z',
            confidence: {
              aggregate: 0.91,
              readyForPublish: true,
              missingCritical: [],
              fields: {
                identity: { score: 0.95 },
                category: { score: 0.85 },
              },
            },
            critic: { ebay_ready_score: 0.82, issues: [] },
            worker_meta: {
              identity: { ok: true, retriesRequested: 0, sources: ['ebay_catalog'] },
              category: { ok: true, retriesRequested: 1, sources: ['gemini'] },
            },
            conflicts: [],
          },
        },
      },
    };
    const run = mapProductToRun(product);
    expect(run.pipeline).toBe('v4');
    expect(run.productId).toBe('p-v4');
    expect(run.sku).toBe('SKU-v4');
    expect(run.confidence.aggregate).toBe(0.91);
    expect(run.confidence.readyForPublish).toBe(true);
    expect(run.workerSummary.identity.confidence).toBe(0.95);
    expect(run.workerSummary.category.retriesRequested).toBe(1);
    expect(run.criticScore).toBe(0.82);
  });

  it('maps an identify_v3 product to pipeline=v3 using overall_score + field_confidence', () => {
    const product = {
      id: 'p-v3',
      identification: { sku: 'SKU-v3' },
      identifyV3CheckedAtIso: '2026-04-29T12:00:00.000Z',
      ops: {
        data_quality: {
          identify_v3: {
            checked_at_iso: '2026-04-29T12:00:00.000Z',
            overall_score: 0.7,
            field_confidence: {
              identity: 0.8,
              category: 0.6,
            },
            marketplace_readiness: { ebay: 0.65 },
          },
        },
      },
    };
    const run = mapProductToRun(product);
    expect(run.pipeline).toBe('v3');
    expect(run.confidence.aggregate).toBe(0.7);
    expect(run.workerSummary.identity.confidence).toBe(0.8);
    expect(run.workerSummary.category.confidence).toBe(0.6);
    expect(run.criticScore).toBe(0.65);
  });
});
