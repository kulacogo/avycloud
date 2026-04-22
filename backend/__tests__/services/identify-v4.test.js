'use strict';

/**
 * identify-v4.test.js — Orchestrator-Skeleton tests.
 *
 * Uses require.cache patching (CJS-compatible) for all worker modules +
 * stage1 + product-store (as per .claude/rules/backend.md).
 */

// -------------------------------------------------------------------------
// 1. Declare controllable mocks + patch require.cache BEFORE loading SUT.
// -------------------------------------------------------------------------

const baseStage1 = {
  identity: {
    brand: 'Sony',
    model: 'WH-1000XM5',
    variant: 'Schwarz',
    color: 'Schwarz',
    weight_grams: 250,
    internalCategory: 'Elektronik > Kopfhoerer',
  },
  barcodes: { ean: '4548736132610', gtin: '', upc: '', ranked: [], explicit: [] },
  ocrPayload: { text: 'Sony WH-1000XM5' },
  imageParts: [{ data: 'base64', mimeType: 'image/jpeg' }],
  uploadedImages: [{ url: 'https://storage.example/x.jpg' }],
  _meta: { durationMs: 42 },
};

const stage1Mock = vi.fn(async () => JSON.parse(JSON.stringify(baseStage1)));

const identityWorkerMock = vi.fn(async () => ({
  ok: true,
  domain: 'identity',
  resolved: { ean: '4548736132610', gtin: '4548736132610', brand: 'Sony', mpn: 'WH1000XM5B' },
  confidence: { ean: 0.95, gtin: 0.95, brand: 0.92, mpn: 0.85 },
  sources: [{ type: 'lookup_gtin', url: 'https://ean.example/x' }],
  meta: { durationMs: 100, toolsCalled: [{ name: 'lookup_gtin', ok: true }] },
}));

const categoryWorkerMock = vi.fn(async () => ({
  ok: true,
  domain: 'category',
  resolved: {
    categoryId: '112529',
    breadcrumb: 'TV, Video & Audio > Kopfhoerer',
    categoryName: 'Kopfhoerer',
    categorySource: 'auto:catalog',
    requiredAspects: [{ name: 'Marke' }, { name: 'Modell' }],
    recommendedAspects: [{ name: 'Farbe' }],
  },
  confidence: { categoryId: 0.95 },
  sources: [{ type: 'ebay_catalog', via: 'catalog', categoryId: '112529', confidence: 0.95 }],
  meta: { durationMs: 80 },
}));

const criticWorkerMock = vi.fn(async () => ({
  ok: true,
  domain: 'critic',
  resolved: {
    critiqued: true,
    issues: [],
    fix_hints: [],
    ebay_ready_score: 0.85,
    aspect_cap_applied: false,
    refinement_needed_workers: [],
  },
  confidence: { ebay_ready: 0.85 },
  sources: [],
  meta: { durationMs: 30, geminiCalls: 0 },
}));

const saveProductV2Mock = vi.fn(async (product /* , options */) => ({
  id: product.id,
  ok: true,
}));

// --- Patch require.cache ---------------------------------------------------

const stage1Path = require.resolve('../../lib/identify-v3-stage1');
require(stage1Path);
require.cache[stage1Path] = {
  id: stage1Path,
  filename: stage1Path,
  loaded: true,
  exports: { runStage1Recognition: stage1Mock },
};

const identityPath = require.resolve('../../lib/identify-workers/identity-worker');
require(identityPath);
require.cache[identityPath] = {
  id: identityPath,
  filename: identityPath,
  loaded: true,
  exports: { runIdentityWorker: identityWorkerMock },
};

const categoryPath = require.resolve('../../lib/identify-workers/category-worker');
require(categoryPath);
require.cache[categoryPath] = {
  id: categoryPath,
  filename: categoryPath,
  loaded: true,
  exports: { runCategoryWorker: categoryWorkerMock },
};

const criticPath = require.resolve('../../lib/identify-workers/critic-worker');
require(criticPath);
require.cache[criticPath] = {
  id: criticPath,
  filename: criticPath,
  loaded: true,
  exports: { runCriticWorker: criticWorkerMock },
};

// --- Wave 2 worker mocks (Phase C) — all return minimal ok:true results ---
const noopWaveWorker = (domain) => async () => ({
  ok: true,
  domain,
  resolved: {},
  confidence: {},
  sources: [],
  retriesRequested: [],
  meta: { durationMs: 1, toolsCalled: [], geminiCalls: 0, error: null },
});

for (const [domain, relpath] of [
  ['attributes', '../../lib/identify-workers/attributes-worker'],
  ['seo', '../../lib/identify-workers/seo-worker'],
  ['pricing', '../../lib/identify-workers/pricing-worker'],
  ['image', '../../lib/identify-workers/image-worker'],
  ['gpsr', '../../lib/identify-workers/gpsr-worker'],
]) {
  const p = require.resolve(relpath);
  require(p);
  const runnerName = `run${domain.charAt(0).toUpperCase()}${domain.slice(1)}Worker`;
  require.cache[p] = {
    id: p,
    filename: p,
    loaded: true,
    exports: { [runnerName]: noopWaveWorker(domain), DOMAIN: domain },
  };
}

// Patch product-store BEFORE loading SUT
const productStorePath = require.resolve('../../lib/product-store');
const realProductStore = require(productStorePath);
require.cache[productStorePath] = {
  id: productStorePath,
  filename: productStorePath,
  loaded: true,
  exports: {
    ...realProductStore,
    saveProductV2: saveProductV2Mock,
  },
};

// -------------------------------------------------------------------------
// 2. Load SUT
// -------------------------------------------------------------------------

const {
  identifyProductV4,
  identifyV4Enabled,
  _testables,
} = require('../../services/identify-v4');
const { runWave, mergeWaveResults, assembleProductV4, WORKER_REGISTRY } = _testables;

// -------------------------------------------------------------------------
// 3. Tests
// -------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  stage1Mock.mockImplementation(async () => JSON.parse(JSON.stringify(baseStage1)));
  identityWorkerMock.mockImplementation(async () => ({
    ok: true,
    domain: 'identity',
    resolved: { ean: '4548736132610', gtin: '4548736132610', brand: 'Sony', mpn: 'WH1000XM5B' },
    confidence: { ean: 0.95, gtin: 0.95, brand: 0.92, mpn: 0.85 },
    sources: [{ type: 'lookup_gtin', url: 'https://ean.example/x' }],
    meta: { durationMs: 100, toolsCalled: [{ name: 'lookup_gtin', ok: true }] },
  }));
  categoryWorkerMock.mockImplementation(async () => ({
    ok: true,
    domain: 'category',
    resolved: {
      categoryId: '112529',
      breadcrumb: 'TV, Video & Audio > Kopfhoerer',
      categoryName: 'Kopfhoerer',
      categorySource: 'auto:catalog',
      requiredAspects: [{ name: 'Marke' }, { name: 'Modell' }],
      recommendedAspects: [{ name: 'Farbe' }],
    },
    confidence: { categoryId: 0.95 },
    sources: [{ type: 'ebay_catalog', via: 'catalog', categoryId: '112529', confidence: 0.95 }],
    meta: { durationMs: 80 },
  }));
  criticWorkerMock.mockImplementation(async () => ({
    ok: true,
    domain: 'critic',
    resolved: {
      critiqued: true,
      issues: [],
      fix_hints: [],
      ebay_ready_score: 0.85,
      aspect_cap_applied: false,
      refinement_needed_workers: [],
    },
    confidence: { ebay_ready: 0.85 },
    sources: [],
    meta: { durationMs: 30, geminiCalls: 0 },
  }));
  saveProductV2Mock.mockImplementation(async (p) => ({ id: p.id, ok: true }));
  delete process.env.IDENTIFY_V4;
});

describe('identifyV4Enabled', () => {
  it('returns false by default', () => {
    delete process.env.IDENTIFY_V4;
    expect(identifyV4Enabled()).toBe(false);
  });

  it('returns true when IDENTIFY_V4=true', () => {
    process.env.IDENTIFY_V4 = 'true';
    expect(identifyV4Enabled()).toBe(true);
    process.env.IDENTIFY_V4 = '1';
    expect(identifyV4Enabled()).toBe(true);
    process.env.IDENTIFY_V4 = 'on';
    expect(identifyV4Enabled()).toBe(true);
    delete process.env.IDENTIFY_V4;
  });
});

describe('identifyProductV4 orchestrator', () => {
  it('runs Stage 1 → identity + category in parallel → critic', async () => {
    const res = await identifyProductV4({
      files: [{ buffer: Buffer.from('x'), mimetype: 'image/jpeg' }],
      barcodes: '4548736132610',
    });

    expect(stage1Mock).toHaveBeenCalledTimes(1);
    expect(identityWorkerMock).toHaveBeenCalledTimes(1);
    expect(categoryWorkerMock).toHaveBeenCalledTimes(1);
    expect(criticWorkerMock).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(res.meta.pipeline).toBe('v4');
    expect(Array.isArray(res.meta.waves)).toBe(true);
    expect(res.meta.waves[0].workers).toEqual(['identity', 'category']);
  });

  it('returns fallback: v3 when Stage 1 throws', async () => {
    stage1Mock.mockImplementationOnce(async () => {
      throw new Error('stage1-boom');
    });
    const res = await identifyProductV4({ files: [], barcodes: '' });
    expect(res.ok).toBe(false);
    expect(res.fallback).toBe('v3');
    expect(res.error).toMatch(/stage1-boom/);
    // Downstream workers not invoked
    expect(identityWorkerMock).not.toHaveBeenCalled();
    expect(categoryWorkerMock).not.toHaveBeenCalled();
    expect(criticWorkerMock).not.toHaveBeenCalled();
  });

  it('handles wave-timeout per worker without blocking peers', async () => {
    identityWorkerMock.mockImplementationOnce(
      () => new Promise(() => {}) // never resolves
    );
    // Shorten wave timeout by forcing context.
    // runWave pulls it from context._waveTimeoutMs OR the default.
    // Since identifyProductV4 sets it to DEFAULT_WAVE_TIMEOUT_MS we override
    // by running runWave directly.
    const ctx = { _waveTimeoutMs: 150 };
    const results = await runWave(['identity', 'category'], ctx);
    const identityRes = results.find((r) => r.domain === 'identity');
    const categoryRes = results.find((r) => r.domain === 'category');
    expect(identityRes.ok).toBe(false);
    expect(identityRes.meta.error).toMatch(/timeout/i);
    // category still runs and returns normally
    expect(categoryRes.ok).toBe(true);
  });

  it('honours pipeline-wide timeout with best-effort return', async () => {
    // Force TIMEOUT via env override + fresh module reload.
    const prev = process.env.IDENTIFY_V4_TIMEOUT_MS;
    process.env.IDENTIFY_V4_TIMEOUT_MS = '50';
    // Stall stage1 so pipeline cannot finish in 50ms.
    stage1Mock.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(baseStage1), 500))
    );
    // Clear require cache for SUT to pick up new env
    const sutPath = require.resolve('../../services/identify-v4');
    delete require.cache[sutPath];
    const { identifyProductV4: freshOrchestrator } = require(sutPath);

    const res = await freshOrchestrator({ files: [], barcodes: '' });
    expect(res.ok).toBe(false);
    expect(res.meta.timedOut).toBe(true);
    expect(res.fallback).toBe('v3');

    // Restore
    if (prev == null) delete process.env.IDENTIFY_V4_TIMEOUT_MS;
    else process.env.IDENTIFY_V4_TIMEOUT_MS = prev;
    delete require.cache[sutPath];
    // Re-require so downstream tests in this file use the restored version
    require(sutPath);
  });

  it('autosaves when score >= 0.6 and both workers ok', async () => {
    const res = await identifyProductV4({
      files: [],
      barcodes: '4548736132610',
      tenantId: 'tenantA',
      userId: 'userA',
      autosave: true,
    });
    expect(res.ok).toBe(true);
    expect(saveProductV2Mock).toHaveBeenCalledTimes(1);
    const [productArg, optionsArg] = saveProductV2Mock.mock.calls[0];
    expect(productArg.id).toBeTruthy();
    expect(optionsArg).toEqual(expect.objectContaining({ mode: 'system', tenantId: 'tenantA', userId: 'userA' }));
    expect(res.meta.saved).toBeTruthy();
    expect(res.meta.needs_human_review).toBe(false);
  });

  it('blocks autosave and flags needs_human_review when score < 0.6', async () => {
    criticWorkerMock.mockImplementationOnce(async () => ({
      ok: true,
      domain: 'critic',
      resolved: {
        critiqued: true,
        issues: [{ field: 'title', severity: 'error', message: 'missing' }],
        fix_hints: [],
        ebay_ready_score: 0.4,
        aspect_cap_applied: false,
        refinement_needed_workers: ['seo'],
      },
      confidence: { ebay_ready: 0.4 },
      sources: [],
      meta: { durationMs: 30, geminiCalls: 0 },
    }));
    const res = await identifyProductV4({ files: [], barcodes: '4548736132610', autosave: true });
    expect(saveProductV2Mock).not.toHaveBeenCalled();
    expect(res.meta.saved).toBeNull();
    expect(res.meta.needs_human_review).toBe(true);
  });

  it('never saves when autosave:false even with high score', async () => {
    const res = await identifyProductV4({
      files: [],
      barcodes: '4548736132610',
      autosave: false,
    });
    expect(saveProductV2Mock).not.toHaveBeenCalled();
    expect(res.meta.saved).toBeNull();
    // autosave explicitly off → not flagged for human review
    expect(res.meta.needs_human_review).toBe(false);
  });

  it('assembleProductV4 produces V2-shape with ops.data_quality.identify_v4 metadata', async () => {
    const res = await identifyProductV4({ files: [], barcodes: '4548736132610' });
    const p = res.product;
    expect(p).toBeTruthy();
    expect(p.identification).toBeDefined();
    expect(p.details).toBeDefined();
    expect(p.ops.identify_pipeline).toBe('v4');
    const dq = p.ops.data_quality.identify_v4;
    expect(dq).toBeTruthy();
    expect(dq.checked_at_iso).toBeTruthy();
    expect(Array.isArray(dq.waves)).toBe(true);
    expect(dq.critic).toBeTruthy();
    expect(dq.critic.ebay_ready_score).toBe(0.85);
    expect(dq.worker_meta.identity).toBeTruthy();
    expect(dq.worker_meta.category).toBeTruthy();
    expect(dq.worker_meta.critic).toBeTruthy();
    expect(dq.confidence).toBeDefined();
  });

  it('workerReports meta contains all 3 worker results', async () => {
    const res = await identifyProductV4({ files: [], barcodes: '4548736132610' });
    expect(res.meta.workerReports.identity).toBeTruthy();
    expect(res.meta.workerReports.identity.ok).toBe(true);
    expect(res.meta.workerReports.category).toBeTruthy();
    expect(res.meta.workerReports.category.ok).toBe(true);
    expect(res.meta.workerReports.critic).toBeTruthy();
    expect(res.meta.workerReports.critic.ok).toBe(true);
  });

  it('return-shape has product + meta + ok', async () => {
    const res = await identifyProductV4({ files: [], barcodes: '4548736132610' });
    expect(Object.keys(res).sort()).toEqual(expect.arrayContaining(['ok', 'product', 'meta']));
    expect(typeof res.ok).toBe('boolean');
    expect(typeof res.meta).toBe('object');
    expect(typeof res.product).toBe('object');
  });
});

describe('internals', () => {
  it('WORKER_REGISTRY contains identity, category, critic', () => {
    expect(typeof WORKER_REGISTRY.identity).toBe('function');
    expect(typeof WORKER_REGISTRY.category).toBe('function');
    expect(typeof WORKER_REGISTRY.critic).toBe('function');
    // Phase C: all 5 domain workers are now wired up.
    expect(typeof WORKER_REGISTRY.attributes).toBe('function');
    expect(typeof WORKER_REGISTRY.seo).toBe('function');
    expect(typeof WORKER_REGISTRY.pricing).toBe('function');
    expect(typeof WORKER_REGISTRY.image).toBe('function');
    expect(typeof WORKER_REGISTRY.gpsr).toBe('function');
  });

  it('mergeWaveResults writes workerResults and merges resolved fields', () => {
    const ctx = {
      product: { identification: { brand: '' }, details: { identifiers: {} } },
      confidence: {},
      workerResults: {},
      additionalSources: [],
    };
    const results = [
      {
        ok: true,
        domain: 'identity',
        resolved: { brand: 'Sony', ean: '4548736132610', gtin: '4548736132610' },
        confidence: { brand: 0.9, ean: 0.95 },
        sources: [{ type: 'lookup_gtin' }],
        meta: {},
      },
      {
        ok: true,
        domain: 'category',
        resolved: { categoryId: '112529', breadcrumb: 'A > B' },
        confidence: { categoryId: 0.95 },
        sources: [{ type: 'ebay_catalog' }],
        meta: {},
      },
    ];
    const merged = mergeWaveResults(ctx, results);
    expect(merged.workerResults.identity).toBe(results[0]);
    expect(merged.workerResults.category).toBe(results[1]);
    expect(merged._crossRefResolved).toBeTruthy();
    expect(merged._crossRefResolved.brand).toBe('Sony');
    expect(merged._crossRefResolved.categoryId).toBe('112529');
    expect(merged.additionalSources.length).toBe(2);
  });

  it('assembleProductV4 honours empty context defensively', () => {
    const p = assembleProductV4({});
    expect(p.id).toBeTruthy();
    expect(p.ops.identify_pipeline).toBe('v4');
    expect(p.ops.data_quality.identify_v4).toBeTruthy();
    expect(p.identification.name).toBe('Unbekanntes Produkt');
  });
});
