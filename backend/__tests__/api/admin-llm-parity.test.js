/**
 * Integration-Tests: Admin LLM-Quality-Parity Endpoint (Plan F.4b)
 *
 * GET /api/llm-parity
 *   - aggregation by (pipeline, domain) from llm_call_telemetry
 *   - drift detection across pipelines for same domain
 *   - empty-data → empty pipelines + drift_alerts
 *
 * CJS test — uses require.cache-Patching.
 */

const request = require('supertest');
const path = require('path');

require('./_patchGcp');

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

// Mock the llm-parity-dashboard service BEFORE route loads.
const listLlmParitySpy = vi.fn();
patchLocalModule(path.resolve(__dirname, '../../services/llm-parity-dashboard.js'), {
  listLlmParity: listLlmParitySpy,
});

require('./_patchLocalModules');
require('./_setupMocks');
const { createTestApp } = require('./_createApp');
const adminRouter = require('../../routes/admin');

const app = createTestApp(adminRouter);

describe('GET /api/llm-parity', () => {
  beforeEach(() => {
    listLlmParitySpy.mockReset();
  });

  it('aggregates per (pipeline, domain) and returns 200', async () => {
    listLlmParitySpy.mockResolvedValue({
      pipelines: [
        {
          pipeline: 'identify-v3',
          domain: 'identity',
          mean_quality: 0.7,
          mean_latency_ms: 1200,
          mean_cost_usd: 0.001,
          count: 20,
          models: ['gemini-3-pro-preview'],
        },
        {
          pipeline: 'identify-v4',
          domain: 'identity',
          mean_quality: 0.9,
          mean_latency_ms: 1100,
          mean_cost_usd: 0.0012,
          count: 25,
          models: ['gemini-3.1-pro-preview-customtools'],
        },
      ],
      drift_alerts: [],
      total: 45,
      hard_cap: 5000,
    });
    const res = await request(app).get('/api/llm-parity');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.pipelines).toHaveLength(2);
    expect(res.body.data.total).toBe(45);
    const args = listLlmParitySpy.mock.calls[0][0];
    expect(args.tenantId).toBe('default');
  });

  it('surfaces drift_alerts when same domain diverges across pipelines', async () => {
    listLlmParitySpy.mockResolvedValue({
      pipelines: [
        { pipeline: 'identify-v3', domain: 'identity', mean_quality: 0.55, count: 10, mean_latency_ms: null, mean_cost_usd: null, models: [] },
        { pipeline: 'identify-v4', domain: 'identity', mean_quality: 0.92, count: 12, mean_latency_ms: null, mean_cost_usd: null, models: [] },
      ],
      drift_alerts: [
        {
          domain: 'identity',
          gap: 0.37,
          best_pipeline: 'identify-v4',
          best_mean_quality: 0.92,
          worst_pipeline: 'identify-v3',
          worst_mean_quality: 0.55,
          threshold: 0.15,
        },
      ],
      total: 22,
      hard_cap: 5000,
    });
    const res = await request(app).get('/api/llm-parity');
    expect(res.status).toBe(200);
    expect(res.body.data.drift_alerts).toHaveLength(1);
    const alert = res.body.data.drift_alerts[0];
    expect(alert.domain).toBe('identity');
    expect(alert.gap).toBeGreaterThan(0.15);
    expect(alert.best_pipeline).toBe('identify-v4');
  });

  it('returns empty pipelines + drift_alerts when no telemetry exists', async () => {
    listLlmParitySpy.mockResolvedValue({ pipelines: [], drift_alerts: [], total: 0, hard_cap: 5000 });
    const res = await request(app).get('/api/llm-parity');
    expect(res.status).toBe(200);
    expect(res.body.data.pipelines).toEqual([]);
    expect(res.body.data.drift_alerts).toEqual([]);
    expect(res.body.data.total).toBe(0);
  });

  it('propagates 400 from missing tenantId', async () => {
    const err = new Error('tenantId required');
    err.statusCode = 400;
    listLlmParitySpy.mockRejectedValue(err);
    const res = await request(app).get('/api/llm-parity');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('tenantId required');
  });

  it('passes domain + pipeline filters through to service', async () => {
    listLlmParitySpy.mockResolvedValue({ pipelines: [], drift_alerts: [], total: 0, hard_cap: 5000 });
    await request(app)
      .get('/api/llm-parity')
      .query({ domain: 'identity', pipeline: 'identify-v4' });
    const args = listLlmParitySpy.mock.calls[0][0];
    expect(args.domain).toBe('identity');
    expect(args.pipeline).toBe('identify-v4');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Service-Layer Tests for listLlmParity (Plan F.4b)
//
// The route-tests above mock the entire service. Here we test the REAL
// aggregation logic (drift-detection, group-by-(pipeline,scope), mean
// computation, threshold respect, empty-data handling).
//
// Pattern:
//   1. Drop the require.cache entry installed at the top of this file (which
//      stubbed the service to listLlmParitySpy).
//   2. require() the real module — its require('../lib/firestore') resolves to
//      the SAME mocked-firestore singleton already in cache (from _patchGcp).
//   3. Stub firestore.collection(...).where(...).limit(...).get() per-test by
//      replacing the collection method with a controllable chain.
// ─────────────────────────────────────────────────────────────────────────────

describe('listLlmParity service-layer behavior', () => {
  const path = require('path');
  const servicePath = require.resolve('../../services/llm-parity-dashboard.js');

  // Drop the route-test mock entry so we can require the real module fresh.
  let realListLlmParity;
  beforeAll(() => {
    delete require.cache[servicePath];
    // eslint-disable-next-line global-require
    realListLlmParity = require('../../services/llm-parity-dashboard.js').listLlmParity;
  });

  const firestoreModule = require('../../lib/firestore');

  // Build a fake QueryReference that records .where() and .limit() args and
  // returns a snapshot containing `events` from forEach().
  function buildFakeQuery(events) {
    const snapshot = {
      forEach: (cb) => {
        for (const evt of events) {
          cb({ data: () => evt });
        }
      },
      size: events.length,
      empty: events.length === 0,
    };
    const fakeQuery = {
      where: vi.fn(),
      limit: vi.fn(),
      get: vi.fn().mockResolvedValue(snapshot),
    };
    fakeQuery.where.mockReturnValue(fakeQuery);
    fakeQuery.limit.mockReturnValue(fakeQuery);
    return fakeQuery;
  }

  // Drive the firestore.collection() singleton: replace its collection-method
  // with a fn returning our fake query.
  function stubFirestoreEvents(events) {
    const fakeQuery = buildFakeQuery(events);
    firestoreModule.firestore.collection = vi.fn().mockReturnValue(fakeQuery);
    return fakeQuery;
  }

  const prevDriftEnv = process.env.LLM_PARITY_DRIFT_THRESHOLD;
  beforeEach(() => {
    delete process.env.LLM_PARITY_DRIFT_THRESHOLD;
  });
  afterAll(() => {
    if (prevDriftEnv !== undefined) process.env.LLM_PARITY_DRIFT_THRESHOLD = prevDriftEnv;
    else delete process.env.LLM_PARITY_DRIFT_THRESHOLD;
  });

  it('aggregates by (pipeline, scope) correctly — 2 pipelines × 1 scope', async () => {
    stubFirestoreEvents([
      { pipeline: 'identify-v3', scope: 'identity', outputQualityScore: 0.7, latencyMs: 1200, costUsdEstimate: 0.001 },
      { pipeline: 'identify-v3', scope: 'identity', outputQualityScore: 0.72, latencyMs: 1300, costUsdEstimate: 0.0012 },
      { pipeline: 'identify-v4', scope: 'identity', outputQualityScore: 0.9, latencyMs: 1100, costUsdEstimate: 0.0014 },
    ]);
    const out = await realListLlmParity({ tenantId: 'default' });
    expect(out.total).toBe(3);
    expect(out.pipelines).toHaveLength(2);
    const v3 = out.pipelines.find((p) => p.pipeline === 'identify-v3');
    const v4 = out.pipelines.find((p) => p.pipeline === 'identify-v4');
    expect(v3.domain).toBe('identity');
    expect(v3.count).toBe(2);
    expect(v4.count).toBe(1);
  });

  it('computes mean_quality / mean_latency / mean_cost per group', async () => {
    stubFirestoreEvents([
      { pipeline: 'identify-v3', scope: 'identity', outputQualityScore: 0.6, latencyMs: 1000, costUsdEstimate: 0.0010 },
      { pipeline: 'identify-v3', scope: 'identity', outputQualityScore: 0.8, latencyMs: 2000, costUsdEstimate: 0.0030 },
    ]);
    const out = await realListLlmParity({ tenantId: 'default' });
    expect(out.pipelines).toHaveLength(1);
    const row = out.pipelines[0];
    // Mean of 0.6 and 0.8 = 0.7
    expect(row.mean_quality).toBe(0.7);
    // Mean of 1000 and 2000 = 1500
    expect(row.mean_latency_ms).toBe(1500);
    // Mean of 0.001 and 0.003 = 0.002
    expect(row.mean_cost_usd).toBe(0.002);
  });

  it('detects drift when quality-gap > default threshold (0.15)', async () => {
    stubFirestoreEvents([
      { pipeline: 'identify-v3', scope: 'identity', outputQualityScore: 0.55 },
      { pipeline: 'identify-v4', scope: 'identity', outputQualityScore: 0.92 },
    ]);
    const out = await realListLlmParity({ tenantId: 'default' });
    expect(out.drift_alerts).toHaveLength(1);
    const alert = out.drift_alerts[0];
    expect(alert.domain).toBe('identity');
    expect(alert.best_pipeline).toBe('identify-v4');
    expect(alert.worst_pipeline).toBe('identify-v3');
    expect(alert.gap).toBeGreaterThan(0.15);
    expect(alert.threshold).toBe(0.15);
  });

  it('does NOT flag drift when quality-gap < threshold', async () => {
    stubFirestoreEvents([
      { pipeline: 'identify-v3', scope: 'identity', outputQualityScore: 0.78 },
      { pipeline: 'identify-v4', scope: 'identity', outputQualityScore: 0.86 },
    ]);
    const out = await realListLlmParity({ tenantId: 'default' });
    // Gap = 0.08 < 0.15 default → no drift_alert
    expect(out.drift_alerts).toHaveLength(0);
    // But both rows should still exist
    expect(out.pipelines).toHaveLength(2);
  });

  it('respects custom LLM_PARITY_DRIFT_THRESHOLD via env var', async () => {
    process.env.LLM_PARITY_DRIFT_THRESHOLD = '0.05';
    stubFirestoreEvents([
      { pipeline: 'identify-v3', scope: 'identity', outputQualityScore: 0.78 },
      { pipeline: 'identify-v4', scope: 'identity', outputQualityScore: 0.86 },
    ]);
    const out = await realListLlmParity({ tenantId: 'default' });
    // Gap = 0.08 > 0.05 → drift_alert fires with custom threshold
    expect(out.drift_alerts).toHaveLength(1);
    expect(out.drift_alerts[0].threshold).toBe(0.05);
  });

  it('handles empty telemetry collection gracefully', async () => {
    stubFirestoreEvents([]);
    const out = await realListLlmParity({ tenantId: 'default' });
    expect(out.total).toBe(0);
    expect(out.pipelines).toEqual([]);
    expect(out.drift_alerts).toEqual([]);
    expect(out.hard_cap).toBe(5000);
  });

  it('rejects when tenantId is missing (400 BAD_REQUEST)', async () => {
    stubFirestoreEvents([]);
    await expect(realListLlmParity({ tenantId: '' })).rejects.toThrow(/tenantId required/);
    await expect(realListLlmParity({})).rejects.toThrow(/tenantId required/);
  });

  it('filters by domain (skips events with non-matching scope)', async () => {
    stubFirestoreEvents([
      { pipeline: 'identify-v3', scope: 'identity', outputQualityScore: 0.7 },
      { pipeline: 'identify-v3', scope: 'category', outputQualityScore: 0.8 },
      { pipeline: 'identify-v4', scope: 'identity', outputQualityScore: 0.9 },
    ]);
    const out = await realListLlmParity({ tenantId: 'default', domain: 'identity' });
    // Only the 2 events with scope=identity should be aggregated
    const allDomains = new Set(out.pipelines.map((p) => p.domain));
    expect(allDomains.size).toBe(1);
    expect(allDomains.has('identity')).toBe(true);
    expect(out.pipelines.find((p) => p.pipeline === 'identify-v3').count).toBe(1);
    expect(out.pipelines.find((p) => p.pipeline === 'identify-v4').count).toBe(1);
  });

  it('filters by pipeline (skips events from other pipelines)', async () => {
    stubFirestoreEvents([
      { pipeline: 'identify-v3', scope: 'identity', outputQualityScore: 0.7 },
      { pipeline: 'identify-v4', scope: 'identity', outputQualityScore: 0.9 },
      { pipeline: 'chat-v3', scope: 'identity', outputQualityScore: 0.85 },
    ]);
    const out = await realListLlmParity({ tenantId: 'default', pipeline: 'identify-v4' });
    expect(out.pipelines).toHaveLength(1);
    expect(out.pipelines[0].pipeline).toBe('identify-v4');
  });

  it('drift across 3 pipelines uses the max-min gap (not mean)', async () => {
    stubFirestoreEvents([
      { pipeline: 'identify-v3', scope: 'identity', outputQualityScore: 0.5 },
      { pipeline: 'identify-v4', scope: 'identity', outputQualityScore: 0.7 },
      { pipeline: 'chat-v3', scope: 'identity', outputQualityScore: 0.95 },
    ]);
    const out = await realListLlmParity({ tenantId: 'default' });
    expect(out.drift_alerts).toHaveLength(1);
    const alert = out.drift_alerts[0];
    // Gap should be 0.95 - 0.5 = 0.45, best=chat-v3, worst=identify-v3
    expect(alert.best_pipeline).toBe('chat-v3');
    expect(alert.worst_pipeline).toBe('identify-v3');
    expect(alert.gap).toBeCloseTo(0.45, 4);
  });

  it('skips drift-detection when a domain has only one pipeline', async () => {
    stubFirestoreEvents([
      // identity in 2 pipelines (high gap → drift), category in only 1 (no drift)
      { pipeline: 'identify-v3', scope: 'identity', outputQualityScore: 0.5 },
      { pipeline: 'identify-v4', scope: 'identity', outputQualityScore: 0.95 },
      { pipeline: 'identify-v4', scope: 'category', outputQualityScore: 0.6 },
    ]);
    const out = await realListLlmParity({ tenantId: 'default' });
    expect(out.drift_alerts).toHaveLength(1);
    expect(out.drift_alerts[0].domain).toBe('identity');
  });

  it('groups unknown/missing pipeline + scope as "unknown" sentinel', async () => {
    stubFirestoreEvents([
      { pipeline: 'identify-v3', scope: 'identity', outputQualityScore: 0.8 },
      { /* no pipeline, no scope */ outputQualityScore: 0.7 },
    ]);
    const out = await realListLlmParity({ tenantId: 'default' });
    const unknownRow = out.pipelines.find((p) => p.pipeline === 'unknown');
    expect(unknownRow).toBeTruthy();
    expect(unknownRow.domain).toBe('unknown');
  });
});
