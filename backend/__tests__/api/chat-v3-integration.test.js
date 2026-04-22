/**
 * Integration-Tests: Chat V3 Pipeline-Routing in /api/chat
 *
 * Verifiziert die V3 → V2 → Legacy Kaskade:
 * - CHAT_V3=false   → default V2 path (pipeline='v2')
 * - CHAT_V3=true    → V3 path (pipeline='v3')
 * - V3 throws       → automatic fallback to V2 (pipeline='v2')
 * - V3 + V2 throw   → fallback to Legacy (pipeline='legacy')
 * - Explicit pipeline='legacy' in body overrides CHAT_V3
 *
 * CJS test file — nutzt require.cache-Patching (kein vi.mock für CJS).
 */

// globals: true in vitest.config.js makes describe, it, expect, beforeEach, vi available
const request = require('supertest');
const path = require('path');

// ─── 1) GCP packages must be patched BEFORE any lib module loads ──────────────
require('./_patchGcp');

// ─── 2) Patch rate-limit + chat-service modules before route loads ────────────

// Helper: patch a local module in require.cache
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

// Bypass rate limiter so we can fire many requests in the test run.
patchLocalModule(path.resolve(__dirname, '../../lib/rate-limit.js'), {
  identifyLimiter: (req, res, next) => next(),
  generalLimiter: (req, res, next) => next(),
});

// Mock chat services with controllable spies.
const chatV3Spy = vi.fn();
const chatV3EnabledSpy = vi.fn();
patchLocalModule(path.resolve(__dirname, '../../services/product-chat-v3.js'), {
  runProductChatV3: chatV3Spy,
  chatV3Enabled: chatV3EnabledSpy,
});

const chatV2Spy = vi.fn();
patchLocalModule(path.resolve(__dirname, '../../services/product-chat-v2.js'), {
  runProductChatV2: chatV2Spy,
});

const chatLegacySpy = vi.fn();
patchLocalModule(path.resolve(__dirname, '../../services/product-chat.js'), {
  runProductChat: chatLegacySpy,
});

// Chat sessions — noop stubs.
patchLocalModule(path.resolve(__dirname, '../../lib/chat-sessions.js'), {
  buildSessionId: (u, p) => `${u || 'u'}__${p || 'p'}`,
  getSession: vi.fn().mockResolvedValue(null),
  appendMessages: vi.fn().mockResolvedValue(),
  clearSession: vi.fn().mockResolvedValue(),
  getGeminiHistory: () => [],
});

// Now load _patchLocalModules (rbac etc.) and the route.
require('./_patchLocalModules');
const { spies: firebaseSpies } = require('./_setupMocks');
const { createTestApp } = require('./_createApp');
const identifyRouter = require('../../routes/identify');

const app = createTestApp(identifyRouter);

// ─── 3) Shared fixtures / helpers ─────────────────────────────────────────────

const SAMPLE_PRODUCT = {
  id: 'SKU-V3-TEST',
  identification: { name: 'Test Product', brand: 'ACME', sku: 'SKU-V3-TEST' },
  details: { identifiers: { ean: '1234567890123' } },
};

const V3_RESULT = {
  message: 'V3 answer',
  datasheetChanges: [],
  imageSuggestions: [],
  evidence: [],
  confidence: { overall: 0.9, readyForPublish: true, fieldScores: {}, conflicts: [], missingCritical: [] },
  trace: { iterations: 1, toolCalls: [], thoughts: [], groundingChunks: [], urls: [] },
  model: 'gemini-3-pro-preview',
  iterations: 1,
};

const V2_RESULT = {
  message: 'V2 answer',
  modelUsed: 'gemini-3-pro-preview',
};

const LEGACY_RESULT = {
  message: 'Legacy answer',
  modelUsed: 'gemini-3-pro-preview',
};

function resetSpies() {
  chatV3Spy.mockReset();
  chatV3EnabledSpy.mockReset();
  chatV2Spy.mockReset();
  chatLegacySpy.mockReset();
  firebaseSpies.getProduct?.mockReset();
  firebaseSpies.getProduct?.mockResolvedValue(SAMPLE_PRODUCT);
}

describe('POST /api/chat — pipeline routing', () => {
  beforeEach(() => {
    resetSpies();
    delete process.env.CHAT_V3;
    process.env.CHAT_GROUNDING = 'true';
  });

  it('CHAT_V3=false → default V2 path, pipeline=v2', async () => {
    chatV3EnabledSpy.mockReturnValue(false);
    chatV2Spy.mockResolvedValue({ ...V2_RESULT });

    const res = await request(app)
      .post('/api/chat')
      .send({ productId: SAMPLE_PRODUCT.id, message: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.pipeline).toBe('v2');
    expect(chatV3Spy).not.toHaveBeenCalled();
    expect(chatV2Spy).toHaveBeenCalledTimes(1);
    expect(chatLegacySpy).not.toHaveBeenCalled();
  });

  it('CHAT_V3=true → V3 path, pipeline=v3', async () => {
    chatV3EnabledSpy.mockReturnValue(true);
    chatV3Spy.mockResolvedValue({ ...V3_RESULT });

    const res = await request(app)
      .post('/api/chat')
      .send({ productId: SAMPLE_PRODUCT.id, message: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.pipeline).toBe('v3');
    expect(chatV3Spy).toHaveBeenCalledTimes(1);
    expect(chatV2Spy).not.toHaveBeenCalled();
    expect(chatLegacySpy).not.toHaveBeenCalled();
  });

  it('V3 throws → automatic fallback to V2, pipeline=v2', async () => {
    chatV3EnabledSpy.mockReturnValue(true);
    chatV3Spy.mockRejectedValue(new Error('chat-v3 failed: boom'));
    chatV2Spy.mockResolvedValue({ ...V2_RESULT });

    const res = await request(app)
      .post('/api/chat')
      .send({ productId: SAMPLE_PRODUCT.id, message: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.pipeline).toBe('v2');
    expect(chatV3Spy).toHaveBeenCalledTimes(1);
    expect(chatV2Spy).toHaveBeenCalledTimes(1);
    expect(chatLegacySpy).not.toHaveBeenCalled();
  });

  it('V3 + V2 both throw → fallback to Legacy, pipeline=legacy', async () => {
    chatV3EnabledSpy.mockReturnValue(true);
    chatV3Spy.mockRejectedValue(new Error('chat-v3 failed: boom'));
    chatV2Spy.mockRejectedValue(new Error('v2 network error'));
    chatLegacySpy.mockResolvedValue({ ...LEGACY_RESULT });

    const res = await request(app)
      .post('/api/chat')
      .send({ productId: SAMPLE_PRODUCT.id, message: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.pipeline).toBe('legacy');
    expect(chatV3Spy).toHaveBeenCalledTimes(1);
    expect(chatV2Spy).toHaveBeenCalledTimes(1);
    expect(chatLegacySpy).toHaveBeenCalledTimes(1);
  });

  it('Explicit pipeline=legacy in body → overrides CHAT_V3=true', async () => {
    chatV3EnabledSpy.mockReturnValue(true); // CHAT_V3 aktiv, sollte aber ignoriert werden
    chatLegacySpy.mockResolvedValue({ ...LEGACY_RESULT });

    const res = await request(app)
      .post('/api/chat')
      .send({ productId: SAMPLE_PRODUCT.id, message: 'hello', pipeline: 'legacy' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.pipeline).toBe('legacy');
    expect(chatV3Spy).not.toHaveBeenCalled();
    expect(chatV2Spy).not.toHaveBeenCalled();
    expect(chatLegacySpy).toHaveBeenCalledTimes(1);
  });

  it('readyForPublish=false → response carries needsHumanReview flag', async () => {
    chatV3EnabledSpy.mockReturnValue(true);
    chatV3Spy.mockResolvedValue({
      ...V3_RESULT,
      confidence: {
        overall: 0.4,
        readyForPublish: false,
        fieldScores: {},
        conflicts: [],
        missingCritical: ['brand', 'gtin'],
      },
    });

    const res = await request(app)
      .post('/api/chat')
      .send({ productId: SAMPLE_PRODUCT.id, message: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body.pipeline).toBe('v3');
    expect(res.body.data.needsHumanReview).toBe(true);
    expect(res.body.data.lowConfidenceFields).toEqual(['brand', 'gtin']);
  });

  it('All pipelines fail → 500 CHAT_ALL_PIPELINES_FAILED', async () => {
    chatV3EnabledSpy.mockReturnValue(true);
    chatV3Spy.mockRejectedValue(new Error('v3 kaput'));
    chatV2Spy.mockRejectedValue(new Error('v2 kaput'));
    chatLegacySpy.mockRejectedValue(new Error('legacy kaput'));

    const res = await request(app)
      .post('/api/chat')
      .send({ productId: SAMPLE_PRODUCT.id, message: 'hello' });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('CHAT_ALL_PIPELINES_FAILED');
    expect(res.body.error.details).toEqual(
      expect.objectContaining({ v3: expect.any(String), v2: expect.any(String), legacy: expect.any(String) }),
    );
  });

  it('Invalid pipeline value falls back to auto (uses env default)', async () => {
    chatV3EnabledSpy.mockReturnValue(false);
    chatV2Spy.mockResolvedValue({ ...V2_RESULT });

    const res = await request(app)
      .post('/api/chat')
      .send({ productId: SAMPLE_PRODUCT.id, message: 'hello', pipeline: 'nonsense' });

    expect(res.status).toBe(200);
    expect(res.body.pipeline).toBe('v2');
    expect(chatV2Spy).toHaveBeenCalledTimes(1);
  });
});
