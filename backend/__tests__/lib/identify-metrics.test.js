'use strict';

// Mock the firestore module via require.cache (see backend.md — CJS pattern).
// We mock both `firestore.collection().add()` for writes and a tiny chainable
// query stub for getIdentifyHealth() aggregation reads.

const addCalls = [];
const mockAdd = vi.fn(async (doc) => {
  addCalls.push(doc);
  return { id: `doc-${addCalls.length}` };
});

let mockDocs = [];
const mockGet = vi.fn(async () => ({ docs: mockDocs.map((data) => ({ data: () => data })) }));
const mockWhere = vi.fn(function chainable() {
  return { where: mockWhere, get: mockGet };
});
const mockCollection = vi.fn(() => ({ add: mockAdd, where: mockWhere }));

const firestorePath = require.resolve('../../lib/firestore');
require(firestorePath);
require.cache[firestorePath] = {
  id: firestorePath,
  filename: firestorePath,
  loaded: true,
  exports: { firestore: { collection: mockCollection } },
};

const loggerPath = require.resolve('../../lib/logger');
require(loggerPath);
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
};

const { recordIdentifyMetric, getIdentifyHealth, METRICS_COLLECTION } = require('../../lib/identify-metrics');

beforeEach(() => {
  addCalls.length = 0;
  mockDocs = [];
  vi.clearAllMocks();
});

describe('recordIdentifyMetric', () => {
  it('writes a normalized document with all expected fields', async () => {
    await recordIdentifyMetric({
      tenantId: 'avycloud',
      pipeline: 'v3',
      durationMs: 4123,
      status: 'success',
      imageCount: 3,
      barcodeCount: 1,
      productId: 'prod-abc',
    });

    expect(mockCollection).toHaveBeenCalledWith(METRICS_COLLECTION);
    expect(addCalls).toHaveLength(1);
    const doc = addCalls[0];
    expect(doc.tenantId).toBe('avycloud');
    expect(doc.pipeline).toBe('v3');
    expect(doc.durationMs).toBe(4123);
    expect(doc.status).toBe('success');
    expect(doc.imageCount).toBe(3);
    expect(doc.barcodeCount).toBe(1);
    expect(doc.productId).toBe('prod-abc');
    expect(doc.timestamp instanceof Date).toBe(true);
  });

  it('truncates long error messages to 500 chars', async () => {
    const longMessage = 'x'.repeat(2000);
    await recordIdentifyMetric({ status: 'error', errorCode: 'BOOM', errorMessage: longMessage });
    expect(addCalls[0].errorMessage).toHaveLength(500);
  });

  it('never throws if firestore add fails (fire-and-forget)', async () => {
    mockAdd.mockRejectedValueOnce(new Error('firestore down'));
    await expect(
      recordIdentifyMetric({ tenantId: 'avycloud', status: 'success' }),
    ).resolves.toBeUndefined();
  });

  it('defaults missing fields without throwing', async () => {
    await recordIdentifyMetric({});
    const doc = addCalls[0];
    expect(doc.tenantId).toBe('default');
    expect(doc.pipeline).toBe('unknown');
    expect(doc.status).toBe('unknown');
    expect(doc.durationMs).toBe(0);
    expect(doc.errorMessage).toBeNull();
  });
});

describe('getIdentifyHealth', () => {
  it('returns zeros for an empty window', async () => {
    mockDocs = [];
    const health = await getIdentifyHealth({ tenantId: 'avycloud', windowMs: 60_000 });
    expect(health.total).toBe(0);
    expect(health.success).toBe(0);
    expect(health.successRate).toBeNull();
    expect(health.durations.count).toBe(0);
    expect(health.lastFailure).toBeNull();
  });

  it('aggregates counts, success rate, and percentiles correctly', async () => {
    mockDocs = [
      { status: 'success', pipeline: 'v3', durationMs: 1000, timestamp: new Date() },
      { status: 'success', pipeline: 'v3', durationMs: 2000, timestamp: new Date() },
      { status: 'success', pipeline: 'grounding', durationMs: 5000, timestamp: new Date() },
      { status: 'success', pipeline: 'v3', durationMs: 10000, timestamp: new Date() },
      { status: 'timeout', pipeline: 'grounding', durationMs: 170000, errorCode: 'HTTP_504', errorMessage: 'budget', timestamp: new Date() },
      { status: 'error', pipeline: 'legacy', durationMs: 30000, errorCode: 'HTTP_500', errorMessage: 'oops', timestamp: new Date() },
    ];

    const health = await getIdentifyHealth({ tenantId: 'avycloud', windowMs: 24 * 60 * 60 * 1000 });

    expect(health.total).toBe(6);
    expect(health.success).toBe(4);
    expect(health.successRate).toBeCloseTo(4 / 6, 5);
    expect(health.byStatus.success).toBe(4);
    expect(health.byStatus.timeout).toBe(1);
    expect(health.byStatus.error).toBe(1);
    expect(health.byPipeline.v3).toBe(3);
    expect(health.byPipeline.grounding).toBe(2);
    expect(health.byError.HTTP_504).toBe(1);
    expect(health.byError.HTTP_500).toBe(1);
    expect(health.durations.count).toBe(4);
    expect(health.durations.avgMs).toBe(4500);
    expect(health.lastFailure).not.toBeNull();
  });
});
