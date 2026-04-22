/**
 * Integration-Tests: Identify V4 Branch in /api/v2/identify
 *
 * Verifiziert das V4-Opt-In-Routing:
 * - IDENTIFY_V4=false (default) → V3 wird aufgerufen, V4 nicht
 * - IDENTIFY_V4=true + V4 ok:true → Response enthält meta.pipeline='v4'
 * - IDENTIFY_V4=true + V4 throws → V3-Fallback läuft
 * - IDENTIFY_V4=true + V4 ok:false → V3-Fallback läuft
 * - IDENTIFY_V4=true + V4 ok:true → V3 NICHT aufgerufen (Short-Circuit)
 * - tenantId wird von req.user.tenantId an V4 durchgereicht
 *
 * CJS test file — nutzt require.cache-Patching (kein vi.mock für CJS).
 */

// globals: true in vitest.config.js → describe, it, expect, beforeEach, vi available
const request = require('supertest');
const path = require('path');

// ─── 1) Patch GCP before any lib loads ───────────────────────────────────────
require('./_patchGcp');

// ─── 2) Patch local modules used by /v2/identify ────────────────────────────

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

// Rate limiter bypass.
patchLocalModule(path.resolve(__dirname, '../../lib/rate-limit.js'), {
  identifyLimiter: (req, res, next) => next(),
  generalLimiter: (req, res, next) => next(),
});

// V4 service — module does not exist in repo yet (Phase B4), so we must
// pre-register it in require.cache under the resolved-path key derived from
// the route's require('../services/identify-v4') call. We resolve relative to
// the routes directory.
const v4ServicePath = path.resolve(__dirname, '../../services/identify-v4.js');
const v4Spy = vi.fn();
const v4EnabledSpy = vi.fn();
require.cache[v4ServicePath] = {
  id: v4ServicePath,
  filename: v4ServicePath,
  loaded: true,
  exports: {
    identifyProductV4: v4Spy,
    identifyV4Enabled: v4EnabledSpy,
  },
  children: [],
  paths: [],
};

// V3 service spy (for fallback verification).
const v3Spy = vi.fn();
patchLocalModule(path.resolve(__dirname, '../../services/identify-v3.js'), {
  identifyProductV3: v3Spy,
});

// Grounding client — stub to force V3/legacy fallback chain after V3 returns.
patchLocalModule(path.resolve(__dirname, '../../lib/gemini3-client.js'), {
  identifyProductWithGrounding: vi.fn().mockRejectedValue(new Error('grounding disabled in test')),
});

// Legacy enrichment pipeline — stub for legacy-fallback safety.
patchLocalModule(path.resolve(__dirname, '../../services/enrichment-v2.js'), {
  runSerpapiFreePipeline: vi.fn().mockResolvedValue({
    record: { sku: null, title_ebay: 'legacy', brand: 'legacy' },
    locale: 'de-DE',
    barcodes: [],
    ocr: null,
    llm: null,
    barcodeInsights: null,
    quality: null,
  }),
});

// Vision OCR — no-op.
patchLocalModule(path.resolve(__dirname, '../../lib/vision-ocr.js'), {
  extractOcrPayload: vi.fn().mockResolvedValue({ textSnippets: [], barcodes: [] }),
});

// Storage upload — stub.
patchLocalModule(path.resolve(__dirname, '../../lib/storage.js'), {
  uploadImage: vi.fn().mockResolvedValue({ url: 'https://mock/img.jpg', width: 800, height: 800 }),
});

// Enrichment helpers — no-ops.
patchLocalModule(path.resolve(__dirname, '../../services/enrichment.js'), {
  ensureCategories: vi.fn().mockResolvedValue(undefined),
  runDatasheetReview: vi.fn().mockResolvedValue(undefined),
  prefetchWebEvidenceForIdentify: vi.fn().mockResolvedValue(null),
  applyEbayTaxonomy: vi.fn((p) => p),
  applyKauflandTaxonomy: vi.fn((p) => p),
});

// v2 product builder — pass-through.
patchLocalModule(path.resolve(__dirname, '../../lib/v2-product-builder.js'), {
  buildProductFromV2Record: vi.fn((record, opts) => ({
    id: opts?.fallbackId || 'legacy-id',
    identification: { name: 'legacy', brand: 'legacy', sku: null, barcodes: [] },
    details: { attributes: {}, identifiers: {}, images: [], pricing: {} },
    marketplace: {},
    ops: {},
    notes: {},
  })),
});

// Chat services — referenced at router load time, but not exercised here.
patchLocalModule(path.resolve(__dirname, '../../services/product-chat.js'), {
  runProductChat: vi.fn(),
});
patchLocalModule(path.resolve(__dirname, '../../services/product-chat-v2.js'), {
  runProductChatV2: vi.fn(),
});
patchLocalModule(path.resolve(__dirname, '../../services/product-chat-v3.js'), {
  runProductChatV3: vi.fn(),
  chatV3Enabled: vi.fn(() => false),
});

// Chat sessions — noop stubs.
patchLocalModule(path.resolve(__dirname, '../../lib/chat-sessions.js'), {
  buildSessionId: (u, p) => `${u || 'u'}__${p || 'p'}`,
  getSession: vi.fn().mockResolvedValue(null),
  appendMessages: vi.fn().mockResolvedValue(),
  clearSession: vi.fn().mockResolvedValue(),
  getGeminiHistory: () => [],
});

// ─── 3) Load route with _patchLocalModules (rbac etc.) ──────────────────────
require('./_patchLocalModules');
const { spies: firebaseSpies, firestoreModule } = require('./_setupMocks');

// Patch firestore.collection('warehouseBins').doc().get() to return exists:true.
const firestoreLib = require('../../lib/firestore');
const warehouseBinSnap = { exists: true, data: () => ({ code: 'PAL-001' }) };
const productsCollectionDoc = {
  update: vi.fn().mockResolvedValue({}),
  get: vi.fn().mockResolvedValue({ exists: false, data: () => ({}) }),
};
vi.spyOn(firestoreLib.firestore, 'collection').mockImplementation((name) => ({
  doc: vi.fn(() => {
    if (name === 'warehouseBins') {
      return { get: vi.fn().mockResolvedValue(warehouseBinSnap) };
    }
    return productsCollectionDoc;
  }),
}));

const { createTestApp } = require('./_createApp');
const identifyRouter = require('../../routes/identify');

// Override the test user to include tenantId.
const app = require('express')();
app.use(require('express').json({ limit: '10mb' }));
app.use((req, res, next) => {
  req.user = {
    uid: 'test-uid-001',
    email: 'admin@trendocean.de',
    tenantId: 'tenant-xyz',
    isAdmin: true,
    emailVerified: true,
  };
  next();
});
app.use('/api', identifyRouter);
const { errorHandler } = require('../../lib/error-handler');
app.use(errorHandler);

// ─── 4) Shared fixtures ─────────────────────────────────────────────────────

const V4_PRODUCT = {
  id: 'V4-SKU-1',
  identification: { name: 'V4 Produkt', brand: 'V4Brand', sku: 'V4-SKU-1' },
  details: {},
};

const V3_RESULT = {
  product: {
    id: 'V3-SKU-1',
    identification: { name: 'V3 Produkt', brand: 'V3Brand', sku: 'V3-SKU-1' },
    details: { identifiers: {}, images: [], attributes: {} },
    ops: {},
  },
  meta: {
    pipeline: 'v3',
    totalDurationMs: 1234,
    confidence: { overallScore: 0.9 },
  },
};

function resetSpies() {
  v4Spy.mockReset();
  v4EnabledSpy.mockReset();
  v3Spy.mockReset();
  firebaseSpies.getProduct?.mockReset();
  firebaseSpies.findProductByStrictIdentifier?.mockReset();
  firebaseSpies.adjustPendingIntakeQuantity?.mockReset();
  firebaseSpies.findProductByStrictIdentifier?.mockResolvedValue(null);
  firebaseSpies.getProduct?.mockResolvedValue(null);
}

function postIdentify(body = {}) {
  const req = request(app).post('/api/v2/identify');
  for (const [k, v] of Object.entries({ paletteCode: 'PAL-001', barcodes: '4012345678901', ...body })) {
    if (v != null) req.field(k, String(v));
  }
  return req;
}

// ─── 5) Tests ───────────────────────────────────────────────────────────────

describe('POST /api/v2/identify — V4 branch routing', () => {
  beforeEach(() => {
    resetSpies();
    delete process.env.IDENTIFY_V4;
    delete process.env.IDENTIFY_V3;
  });

  it('IDENTIFY_V4=false (default) → V4 not called, V3 runs', async () => {
    v4EnabledSpy.mockReturnValue(false);
    process.env.IDENTIFY_V3 = 'true';
    v3Spy.mockResolvedValue(V3_RESULT);
    firebaseSpies.getProduct?.mockResolvedValue(V3_RESULT.product);
    firebaseSpies.saveProductV2?.mockResolvedValue?.(V3_RESULT.product);

    const res = await postIdentify();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(v4Spy).not.toHaveBeenCalled();
    expect(v3Spy).toHaveBeenCalledTimes(1);
    // meta.pipeline is 'v3' (additive top-level tag)
    expect(res.body.meta?.pipeline).toBe('v3');
  });

  it('IDENTIFY_V4=true + V4 ok:true → meta.pipeline=v4, V3 not called', async () => {
    v4EnabledSpy.mockReturnValue(true);
    v4Spy.mockResolvedValue({
      ok: true,
      product: V4_PRODUCT,
      meta: { pipeline: 'v4', totalDurationMs: 987 },
    });

    const res = await postIdentify();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.meta?.pipeline).toBe('v4');
    expect(res.body.data?.id).toBe('V4-SKU-1');
    expect(v4Spy).toHaveBeenCalledTimes(1);
    expect(v3Spy).not.toHaveBeenCalled();
  });

  it('IDENTIFY_V4=true + V4 throws → V3 fallback runs', async () => {
    v4EnabledSpy.mockReturnValue(true);
    v4Spy.mockRejectedValue(new Error('v4 kaput'));
    process.env.IDENTIFY_V3 = 'true';
    v3Spy.mockResolvedValue(V3_RESULT);
    firebaseSpies.getProduct?.mockResolvedValue(V3_RESULT.product);

    const res = await postIdentify();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(v4Spy).toHaveBeenCalledTimes(1);
    expect(v3Spy).toHaveBeenCalledTimes(1);
    expect(res.body.meta?.pipeline).toBe('v3');
  });

  it('IDENTIFY_V4=true + V4 ok:false → V3 fallback runs', async () => {
    v4EnabledSpy.mockReturnValue(true);
    v4Spy.mockResolvedValue({ ok: false, error: 'low_confidence' });
    process.env.IDENTIFY_V3 = 'true';
    v3Spy.mockResolvedValue(V3_RESULT);
    firebaseSpies.getProduct?.mockResolvedValue(V3_RESULT.product);

    const res = await postIdentify();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(v4Spy).toHaveBeenCalledTimes(1);
    expect(v3Spy).toHaveBeenCalledTimes(1);
    expect(res.body.meta?.pipeline).toBe('v3');
  });

  it('IDENTIFY_V4=true + V4 ok:true → V3 never invoked', async () => {
    v4EnabledSpy.mockReturnValue(true);
    v4Spy.mockResolvedValue({
      ok: true,
      product: V4_PRODUCT,
      meta: { pipeline: 'v4' },
    });
    process.env.IDENTIFY_V3 = 'true';

    const res = await postIdentify();
    expect(res.status).toBe(200);
    expect(v3Spy).toHaveBeenCalledTimes(0);
  });

  it('tenantId from req.user is forwarded to V4', async () => {
    v4EnabledSpy.mockReturnValue(true);
    v4Spy.mockResolvedValue({
      ok: true,
      product: V4_PRODUCT,
      meta: { pipeline: 'v4' },
    });

    await postIdentify();
    expect(v4Spy).toHaveBeenCalledTimes(1);
    const callArgs = v4Spy.mock.calls[0][0];
    expect(callArgs.tenantId).toBe('tenant-xyz');
    expect(callArgs.userId).toBe('test-uid-001');
    expect(callArgs.paletteCode).toBe('PAL-001');
    expect(callArgs.barcodes).toBe('4012345678901');
  });
});
