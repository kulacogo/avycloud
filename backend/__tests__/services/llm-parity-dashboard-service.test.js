'use strict';

// Vitest globals (globals: true in vitest.config.js).
//
// Phase F.4b — Direct service-layer tests for `services/llm-parity-dashboard.js`.
//
// Pattern:
//   1. _patchGcp neutralises @google-cloud/* SDK init.
//   2. Patch lib/firestore via require.cache so its `firestore.collection(...)`
//      call returns a controllable fake-query chain.
//   3. Require the REAL service (no mocking — we exercise the aggregation,
//      mean-computation, drift-detection, and error-handling code-paths).
//
// 6 tests:
//   - aggregation by (pipeline, scope)
//   - mean computation for quality/latency/cost
//   - drift detection against the default threshold (0.15)
//   - custom drift threshold via LLM_PARITY_DRIFT_THRESHOLD env-var
//   - empty-data → empty pipelines + drift_alerts + total=0
//   - error-handling: missing tenantId rejects with BAD_REQUEST + statusCode 400

require('../api/_patchGcp');

// ─── Patch lib/firestore so `firestore.collection(...)` is controllable ─────
const firestorePath = require.resolve('../../lib/firestore');
try { require(firestorePath); } catch (_) {}

const collectionMock = vi.fn();
const firestoreFake = { collection: collectionMock };
require.cache[firestorePath] = {
  id: firestorePath,
  filename: firestorePath,
  loaded: true,
  exports: {
    firestore: firestoreFake,
  },
};

// Now require the real service — its `require('../lib/firestore')` resolves to
// the patched cache entry above.
const { listLlmParity } = require('../../services/llm-parity-dashboard');

// ─── Helper: stub firestore.collection().where().limit().get() chain ────────
function stubFirestoreEvents(events) {
  const snapshot = {
    forEach: (cb) => {
      for (const evt of events) cb({ data: () => evt });
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
  collectionMock.mockReturnValue(fakeQuery);
  return fakeQuery;
}

describe('llm-parity-dashboard service (Phase F.4b direct-call)', () => {
  const prevDrift = process.env.LLM_PARITY_DRIFT_THRESHOLD;

  beforeEach(() => {
    collectionMock.mockReset();
    delete process.env.LLM_PARITY_DRIFT_THRESHOLD;
  });

  afterAll(() => {
    if (prevDrift !== undefined) process.env.LLM_PARITY_DRIFT_THRESHOLD = prevDrift;
    else delete process.env.LLM_PARITY_DRIFT_THRESHOLD;
  });

  it('aggregates events by (pipeline, scope)', async () => {
    stubFirestoreEvents([
      { pipeline: 'identify-v3', scope: 'identity', outputQualityScore: 0.7 },
      { pipeline: 'identify-v3', scope: 'category', outputQualityScore: 0.8 },
      { pipeline: 'identify-v4', scope: 'identity', outputQualityScore: 0.9 },
      { pipeline: 'identify-v4', scope: 'category', outputQualityScore: 0.85 },
    ]);
    const out = await listLlmParity({ tenantId: 'default' });
    expect(out.total).toBe(4);
    expect(out.pipelines).toHaveLength(4);
    // Verify each (pipeline, domain) tuple is unique.
    const keys = new Set(out.pipelines.map((p) => `${p.pipeline}|${p.domain}`));
    expect(keys.size).toBe(4);
    expect(keys.has('identify-v3|identity')).toBe(true);
    expect(keys.has('identify-v4|category')).toBe(true);
  });

  it('computes mean_quality / mean_latency_ms / mean_cost_usd correctly', async () => {
    stubFirestoreEvents([
      { pipeline: 'identify-v3', scope: 'identity', outputQualityScore: 0.6, latencyMs: 1000, costUsdEstimate: 0.0010 },
      { pipeline: 'identify-v3', scope: 'identity', outputQualityScore: 0.8, latencyMs: 2000, costUsdEstimate: 0.0030 },
      { pipeline: 'identify-v3', scope: 'identity', outputQualityScore: 0.7, latencyMs: 1500, costUsdEstimate: 0.0020 },
    ]);
    const out = await listLlmParity({ tenantId: 'default' });
    expect(out.pipelines).toHaveLength(1);
    const row = out.pipelines[0];
    // (0.6 + 0.8 + 0.7) / 3 = 0.7
    expect(row.mean_quality).toBeCloseTo(0.7, 4);
    // (1000 + 2000 + 1500) / 3 = 1500
    expect(row.mean_latency_ms).toBe(1500);
    // (0.001 + 0.003 + 0.002) / 3 = 0.002
    expect(row.mean_cost_usd).toBeCloseTo(0.002, 4);
    expect(row.count).toBe(3);
  });

  it('flags drift when quality-gap > default threshold (0.15)', async () => {
    stubFirestoreEvents([
      { pipeline: 'identify-v3', scope: 'identity', outputQualityScore: 0.55 },
      { pipeline: 'identify-v4', scope: 'identity', outputQualityScore: 0.92 },
    ]);
    const out = await listLlmParity({ tenantId: 'default' });
    expect(out.drift_alerts).toHaveLength(1);
    const alert = out.drift_alerts[0];
    expect(alert.domain).toBe('identity');
    expect(alert.best_pipeline).toBe('identify-v4');
    expect(alert.worst_pipeline).toBe('identify-v3');
    expect(alert.gap).toBeGreaterThan(0.15);
    expect(alert.threshold).toBe(0.15);
  });

  it('respects custom LLM_PARITY_DRIFT_THRESHOLD env-var', async () => {
    process.env.LLM_PARITY_DRIFT_THRESHOLD = '0.05';
    stubFirestoreEvents([
      { pipeline: 'identify-v3', scope: 'identity', outputQualityScore: 0.78 },
      { pipeline: 'identify-v4', scope: 'identity', outputQualityScore: 0.86 },
    ]);
    const out = await listLlmParity({ tenantId: 'default' });
    // Gap = 0.08 > custom threshold 0.05 → alert fires.
    expect(out.drift_alerts).toHaveLength(1);
    expect(out.drift_alerts[0].threshold).toBe(0.05);
    expect(out.drift_alerts[0].gap).toBeCloseTo(0.08, 4);
  });

  it('handles empty telemetry collection gracefully', async () => {
    stubFirestoreEvents([]);
    const out = await listLlmParity({ tenantId: 'default' });
    expect(out.total).toBe(0);
    expect(out.pipelines).toEqual([]);
    expect(out.drift_alerts).toEqual([]);
    expect(out.hard_cap).toBe(5000);
  });

  it('rejects with statusCode 400 + BAD_REQUEST when tenantId is missing', async () => {
    // No firestore stub needed — service rejects before reaching the query.
    let caught;
    try {
      await listLlmParity({ tenantId: '' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(caught.message).toMatch(/tenantId required/);
    expect(caught.statusCode).toBe(400);
    expect(caught.code).toBe('BAD_REQUEST');

    // Also rejects when tenantId is entirely absent.
    await expect(listLlmParity({})).rejects.toThrow(/tenantId required/);
  });
});
