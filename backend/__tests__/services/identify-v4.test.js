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
  webImageUrls: ['https://images.example/product-main.jpg'],
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

const wave2WorkerMocks = {
  attributes: vi.fn(noopWaveWorker('attributes')),
  seo: vi.fn(noopWaveWorker('seo')),
  pricing: vi.fn(noopWaveWorker('pricing')),
  image: vi.fn(noopWaveWorker('image')),
  gpsr: vi.fn(noopWaveWorker('gpsr')),
};

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
    exports: { [runnerName]: wave2WorkerMocks[domain], DOMAIN: domain },
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
const {
  runWave,
  mergeWaveResults,
  assembleProductV4,
  WORKER_REGISTRY,
  hasConfidenceImproved,
  findLowConfidenceWorkers,
  mergeRefinementWorkers,
  WAVE_1_WORKERS,
} = _testables;

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
  for (const fn of Object.values(wave2WorkerMocks)) fn.mockClear();
  delete process.env.IDENTIFY_V4;
});

describe('identifyV4Enabled', () => {
  it('returns FALSE by default (explicit opt-in only)', () => {
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

  it('returns false on explicit opt-out', () => {
    for (const v of ['false', '0', 'no', 'off']) {
      process.env.IDENTIFY_V4 = v;
      expect(identifyV4Enabled()).toBe(false);
    }
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
    expect(categoryWorkerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        barcodes: expect.objectContaining({ ean: '4548736132610' }),
      })
    );
    expect(wave2WorkerMocks.image).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          web_image_urls: ['https://images.example/product-main.jpg'],
        }),
      })
    );
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

  it('marks needs_human_review and autosave_error when saveProductV2 throws', async () => {
    saveProductV2Mock.mockImplementationOnce(async () => {
      throw new Error('firestore unavailable');
    });
    const res = await identifyProductV4({
      files: [],
      barcodes: '4548736132610',
      autosave: true,
    });
    expect(res.ok).toBe(true);
    expect(res.meta.saved).toBeNull();
    expect(res.meta.needs_human_review).toBe(true);
    expect(res.product.ops.data_quality.identify_v4.autosave_error).toMatch(/firestore unavailable/);
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

  // -----------------------------------------------------------------------
  // C.1 — Zusatz-Tests (Refinement-Loop early-break + domainToSource +
  // aspect-cap trimming)
  // -----------------------------------------------------------------------

  it('breaks refinement loop when confidence delta < MIN_IMPROVEMENT', () => {
    // hasConfidenceImproved returns false when refinement gain < 0.05.
    // Use only refinement-eligible fields (seo/pricing/...) — Wave 1 fields
    // (identity/category) are explicitly skipped by findLowConfidenceWorkers.
    const ctx = {
      confidence: {
        title: { score: 0.60 },
        price: { score: 0.60 },
      },
      workerResults: {},
    };
    // Refinement result: delta from 0.60 -> 0.62 == 0.02 per field, total 0.04
    // < MIN_IMPROVEMENT 0.05 -> should break the loop.
    const refinementBelow = [
      {
        ok: true,
        domain: 'seo',
        resolved: { title_ebay: 'x' },
        confidence: { title: 0.62 },
      },
      {
        ok: true,
        domain: 'pricing',
        resolved: { price_suggested: 10 },
        confidence: { price: 0.62 },
      },
    ];
    expect(hasConfidenceImproved(ctx, refinementBelow)).toBe(false);

    // Refinement result above threshold should signal improvement.
    const refinementAbove = [
      {
        ok: true,
        domain: 'seo',
        resolved: { title_ebay: 'x' },
        confidence: { title: 0.80 },
      },
    ];
    expect(hasConfidenceImproved(ctx, refinementAbove)).toBe(true);

    // findLowConfidenceWorkers must skip Wave 1 workers even when their
    // confidence is low — only refinement-eligible domains are returned.
    const ctxWithWave1 = {
      confidence: {
        brand: { score: 0.10 },
        categoryId: { score: 0.10 },
        title: { score: 0.50 },
      },
      workerResults: {},
    };
    const lowConf = findLowConfidenceWorkers(ctxWithWave1);
    expect(lowConf).toContain('seo');
    expect(lowConf).not.toContain('identity');
    expect(lowConf).not.toContain('category');
  });

  it('domainToSource maps identity to ean_db when gtin_verified=true', () => {
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
        resolved: { brand: 'Sony', gtin: '4548736132610', gtin_verified: true },
        confidence: { brand: 0.92, gtin: 0.95 },
        sources: [{ type: 'lookup_gtin', ok: true }],
        meta: { toolsCalled: [{ name: 'lookup_gtin', ok: true }] },
      },
    ];
    const merged = mergeWaveResults(ctx, results);
    // The cross-ref confidence MUST cite ean_db as a contributing source so the
    // 0.85-weight applies (instead of the 0.55 gemini_inference fallback).
    const brandConf = merged._crossRefConfidence?.brand;
    expect(brandConf).toBeTruthy();
    expect(Array.isArray(brandConf.sources)).toBe(true);
    expect(brandConf.sources).toContain('ean_db');
    expect(brandConf.sources).not.toContain('gemini_inference');
    // Score reflects ean_db base weight (0.85) — not the gemini_inference 0.55.
    expect(brandConf.score).toBeGreaterThanOrEqual(0.85);
  });

  it('domainToSource falls back to gemini_inference when no GTIN verified', () => {
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
        resolved: { brand: 'Sony', gtin_verified: false },
        confidence: { brand: 0.7 },
        sources: [],
        meta: { toolsCalled: [] },
      },
    ];
    const merged = mergeWaveResults(ctx, results);
    const brandConf = merged._crossRefConfidence?.brand;
    expect(brandConf).toBeTruthy();
    expect(Array.isArray(brandConf.sources)).toBe(true);
    expect(brandConf.sources).toContain('gemini_inference');
    expect(brandConf.sources).not.toContain('ean_db');
    // Score reflects gemini_inference base weight (0.55) — strictly below ean_db.
    expect(brandConf.score).toBeLessThan(0.85);
  });

  // -----------------------------------------------------------------------
  // E.1 — Critic-Refinement-Hint-Merge tests
  // -----------------------------------------------------------------------

  describe('mergeRefinementWorkers (critic hint merge — Phase E)', () => {
    afterEach(() => {
      delete process.env.IDENTIFY_V4_CRITIC_HINTS;
    });

    it('merges critic.refinement_needed_workers with confidence-based detection', () => {
      // Confidence-only path detects 'seo' as low; critic flags 'attributes'.
      // Expectation: union of both, Wave-1-Lock untouched.
      const confidenceBased = ['seo'];
      const criticResult = {
        resolved: { refinement_needed_workers: ['attributes'] },
      };
      const merged = mergeRefinementWorkers(confidenceBased, criticResult);
      expect(merged.sort()).toEqual(['attributes', 'seo']);
    });

    it('respects Wave-1-Lock when critic suggests identity/category', () => {
      // Critic suggested identity + category + attributes — both Wave-1
      // workers MUST be stripped, only 'attributes' remains.
      const confidenceBased = [];
      const criticResult = {
        resolved: { refinement_needed_workers: ['identity', 'category', 'attributes'] },
      };
      const merged = mergeRefinementWorkers(confidenceBased, criticResult);
      expect(merged).toEqual(['attributes']);
      // And confirm WAVE_1_WORKERS is what we expect (foundation contract).
      expect(WAVE_1_WORKERS).toEqual(['identity', 'category']);
    });

    it('skips critic-hint-merge when IDENTIFY_V4_CRITIC_HINTS=false', () => {
      // Flag off → critic suggestions ignored; only confidence-based workers
      // are returned (i.e. behaviour identical to pre-fix).
      process.env.IDENTIFY_V4_CRITIC_HINTS = 'false';
      const confidenceBased = ['seo'];
      const criticResult = {
        resolved: { refinement_needed_workers: ['attributes', 'pricing'] },
      };
      const merged = mergeRefinementWorkers(confidenceBased, criticResult);
      expect(merged).toEqual(['seo']);
    });

    it('dedupes overlapping suggestions and tolerates missing critic result', () => {
      // Same worker on both lists must appear once. Undefined critic =
      // confidence-only path, no crash.
      expect(mergeRefinementWorkers(['seo'], { resolved: { refinement_needed_workers: ['seo'] } }))
        .toEqual(['seo']);
      expect(mergeRefinementWorkers(['seo'], undefined)).toEqual(['seo']);
      expect(mergeRefinementWorkers(['seo'], null)).toEqual(['seo']);
      expect(mergeRefinementWorkers(['seo'], {})).toEqual(['seo']);
    });
  });

  it('aspect-cap-trim path in critic enforces 45-limit when attributes-worker emits 50 items', async () => {
    // Unmock the critic-worker for this single test so the real
    // enforceAspectCap path is exercised end-to-end.
    require.cache[criticPath] = {
      id: criticPath,
      filename: criticPath,
      loaded: true,
      exports: require.cache[criticPath].exports, // placeholder, replaced below
    };
    delete require.cache[criticPath];
    delete require.cache[require.resolve('../../services/identify-v4')];
    const realCritic = require('../../lib/identify-workers/critic-worker');
    require.cache[criticPath] = {
      id: criticPath,
      filename: criticPath,
      loaded: true,
      exports: realCritic,
    };
    const { identifyProductV4: orchestratorWithRealCritic } = require('../../services/identify-v4');

    // Mock attributes-worker to emit 50 distinct item_specifics — assembled
    // product.details.attributes will exceed the 45-cap and the critic must
    // flag aspect_cap_applied via enforceAspectCap.
    const fiftySpecs = Array.from({ length: 50 }, (_v, i) => ({
      key: `Aspect_${String(i + 1).padStart(2, '0')}`,
      value: `Value_${i + 1}`,
    }));
    wave2WorkerMocks.attributes.mockImplementationOnce(async () => ({
      ok: true,
      domain: 'attributes',
      resolved: { item_specifics: fiftySpecs },
      confidence: { requiredAspects: 0.8 },
      sources: [],
      meta: { durationMs: 5 },
    }));

    try {
      const res = await orchestratorWithRealCritic({
        files: [],
        barcodes: '4548736132610',
        autosave: false,
      });
      expect(res.ok).toBe(true);
      const critic = res.product.ops.data_quality.identify_v4.critic;
      expect(critic).toBeTruthy();
      // enforceAspectCap is invoked on the assembled product (which carries
      // 50+ attribute keys); removedCount > 0 -> aspect_cap_applied=true.
      expect(critic.aspect_cap_applied).toBe(true);
    } finally {
      // Restore the critic mock for downstream tests.
      delete require.cache[criticPath];
      require.cache[criticPath] = {
        id: criticPath,
        filename: criticPath,
        loaded: true,
        exports: { runCriticWorker: criticWorkerMock },
      };
      delete require.cache[require.resolve('../../services/identify-v4')];
      // Re-require SUT so subsequent test files see the original mock graph.
      require('../../services/identify-v4');
    }
  });
});
