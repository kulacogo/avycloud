'use strict';

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

const {
  trackExternalCall,
  instrumentExternalCall,
  getExternalApiStats,
} = require('../../lib/external-api-tracker');

beforeEach(() => {
  addCalls.length = 0;
  mockDocs = [];
  vi.clearAllMocks();
  delete process.env.EXTERNAL_API_TRACKER_SAMPLE_RATE;
});

describe('trackExternalCall', () => {
  it('writes a record with normalized fields', async () => {
    await trackExternalCall({
      service: 'brightdata',
      endpoint: 'amazon.de',
      success: true,
      latencyMs: 1234,
    });
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0].service).toBe('brightdata');
    expect(addCalls[0].endpoint).toBe('amazon.de');
    expect(addCalls[0].success).toBe(true);
    expect(addCalls[0].latencyMs).toBe(1234);
  });

  it('honors EXTERNAL_API_TRACKER_SAMPLE_RATE=0 by writing nothing', async () => {
    process.env.EXTERNAL_API_TRACKER_SAMPLE_RATE = '0';
    await trackExternalCall({ service: 'serpapi', success: true, latencyMs: 100 });
    expect(addCalls).toHaveLength(0);
  });

  it('never throws when firestore fails', async () => {
    mockAdd.mockRejectedValueOnce(new Error('firestore down'));
    await expect(trackExternalCall({ service: 'x', success: true, latencyMs: 1 })).resolves.toBeUndefined();
  });
});

describe('instrumentExternalCall', () => {
  it('records success on resolved promise and returns the result', async () => {
    const result = await instrumentExternalCall('serpapi', 'google_shopping', async () => 'ok');
    expect(result).toBe('ok');
    // Tracking is fire-and-forget — wait a tick to let the microtask flush
    await new Promise((r) => setImmediate(r));
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0].success).toBe(true);
    expect(addCalls[0].service).toBe('serpapi');
    expect(addCalls[0].endpoint).toBe('google_shopping');
  });

  it('records failure and re-throws the original error', async () => {
    const boom = new Error('boom');
    boom.code = 'E_BOOM';
    await expect(
      instrumentExternalCall('brightdata', 'amazon.de', async () => { throw boom; }),
    ).rejects.toThrow('boom');
    await new Promise((r) => setImmediate(r));
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0].success).toBe(false);
    expect(addCalls[0].errorCode).toBe('E_BOOM');
  });
});

describe('getExternalApiStats', () => {
  it('returns per-service aggregates with success rate and avg latency', async () => {
    mockDocs = [
      { service: 'brightdata', endpoint: 'amazon.de', success: true, latencyMs: 1000 },
      { service: 'brightdata', endpoint: 'amazon.de', success: false, latencyMs: 2000, errorCode: 'TIMEOUT' },
      { service: 'serpapi', endpoint: 'google_shopping', success: true, latencyMs: 500 },
      { service: 'serpapi', endpoint: 'google_shopping', success: true, latencyMs: 700 },
      { service: 'serpapi', endpoint: 'ebay', success: true, latencyMs: 300 },
    ];
    const stats = await getExternalApiStats({ windowMs: 60_000 });
    expect(stats.totalRecords).toBe(5);
    expect(stats.byService.brightdata.total).toBe(2);
    expect(stats.byService.brightdata.successRate).toBe(0.5);
    expect(stats.byService.brightdata.avgLatencyMs).toBe(1500);
    expect(stats.byService.brightdata.topErrors.TIMEOUT).toBe(1);
    expect(stats.byService.serpapi.total).toBe(3);
    expect(stats.byService.serpapi.successRate).toBe(1);
    expect(stats.byService.serpapi.topEndpoints.google_shopping).toBe(2);
  });
});
