// Vitest globals: true — describe/it/expect/vi available globally.
// Pure unit tests — kein GCP-Patching nötig: wir stubben firestore via require.cache.

const ORIGINAL_ENV = { ...process.env };

function makeFakeFirestore({
  stateDoc = null,
  failStateRead = false,
  failStateWrite = false,
  failBatchCommit = false,
} = {}) {
  const writes = [];
  const batchOps = [];

  const docRef = {
    get: vi.fn(async () => {
      if (failStateRead) throw new Error('boom-read');
      return {
        exists: stateDoc !== null,
        data: () => stateDoc,
      };
    }),
    set: vi.fn(async (data, opts) => {
      if (failStateWrite) throw new Error('boom-write');
      writes.push({ data, opts });
      return {};
    }),
  };

  const collectionRef = {
    doc: vi.fn((id) => ({ id })),
  };

  const batch = {
    set: vi.fn((ref, payload) => {
      batchOps.push({ ref, payload });
    }),
    commit: vi.fn(async () => {
      if (failBatchCommit) throw new Error('boom-commit');
      return [];
    }),
  };

  return {
    doc: vi.fn(() => docRef),
    collection: vi.fn(() => collectionRef),
    batch: vi.fn(() => batch),
    _writes: writes,
    _batchOps: batchOps,
    _docRef: docRef,
    _batch: batch,
  };
}

function patchFirestoreModule(fakeDb) {
  // Patch require.cache for './firestore' from lib/llm-telemetry's perspective
  const firestorePath = require.resolve('../../lib/firestore');
  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: { firestore: fakeDb },
  };
}

function unpatchFirestoreModule() {
  const firestorePath = require.resolve('../../lib/firestore');
  delete require.cache[firestorePath];
}

function freshTelemetry() {
  delete require.cache[require.resolve('../../lib/llm-telemetry')];
  return require('../../lib/llm-telemetry');
}

describe('llm-telemetry', () => {
  beforeEach(() => {
    delete process.env.LLM_TELEMETRY_SAMPLE;
    unpatchFirestoreModule();
  });

  afterEach(() => {
    unpatchFirestoreModule();
    process.env = { ...ORIGINAL_ENV };
  });

  // --- buildDocId / sharding -------------------------------------------------

  it('buildDocId produces sharded id with 8-hex prefix + timestamp + productId', () => {
    const { buildDocId } = freshTelemetry();
    const id = buildDocId('prod123');
    // pattern: ^[0-9a-f]{8}-\d+-prod123$
    expect(id).toMatch(/^[0-9a-f]{8}-\d+-prod123$/);
    // Two consecutive calls produce different ids (prefix random + ts)
    const id2 = buildDocId('prod123');
    expect(id).not.toBe(id2);
  });

  it('buildDocId falls back to noprod when productId missing', () => {
    const { buildDocId } = freshTelemetry();
    expect(buildDocId(null)).toMatch(/^[0-9a-f]{8}-\d+-noprod$/);
    expect(buildDocId(undefined)).toMatch(/^[0-9a-f]{8}-\d+-noprod$/);
    expect(buildDocId('')).toMatch(/^[0-9a-f]{8}-\d+-noprod$/);
  });

  // --- cost-estimation -------------------------------------------------------

  it('estimateCostUsd produces non-negative numbers', () => {
    const { estimateCostUsd } = freshTelemetry();
    expect(estimateCostUsd({ model: 'gemini-3.1-pro-preview-customtools', promptTokens: 1000, completionTokens: 500 })).toBeGreaterThan(0);
    expect(estimateCostUsd({ model: 'gemini-3.1-pro-preview-customtools', promptTokens: 0, completionTokens: 0 })).toBe(0);
    // Missing model → default pricing
    expect(estimateCostUsd({ promptTokens: 1000, completionTokens: 1000 })).toBeGreaterThan(0);
    // Negative tokens clamped to 0
    expect(estimateCostUsd({ model: 'gemini-3-flash-preview', promptTokens: -50, completionTokens: -10 })).toBe(0);
    // Always non-negative
    const v = estimateCostUsd({ model: 'mystery-model', promptTokens: 1e7, completionTokens: 1e7 });
    expect(v).toBeGreaterThanOrEqual(0);
  });

  it('estimateCostUsd differentiates flash vs pro pricing', () => {
    const { estimateCostUsd } = freshTelemetry();
    const proCost = estimateCostUsd({ model: 'gemini-3.1-pro-preview', promptTokens: 1_000_000, completionTokens: 0 });
    const flashCost = estimateCostUsd({ model: 'gemini-3-flash-preview', promptTokens: 1_000_000, completionTokens: 0 });
    expect(proCost).toBeGreaterThan(flashCost);
  });

  // --- sample-rate -----------------------------------------------------------

  it('logLlmCall: sample=0 → no Firestore call', async () => {
    process.env.LLM_TELEMETRY_SAMPLE = '0';
    const fake = makeFakeFirestore({ stateDoc: { sampleRate: 0, changedAt: Date.now() } });
    patchFirestoreModule(fake);
    const mod = freshTelemetry();
    mod._testables.reset();

    for (let i = 0; i < 5; i++) {
      const res = await mod.logLlmCall({
        pipeline: 'identify-v3',
        scope: 'stage3',
        model: 'gemini-3.1-pro-preview',
      });
      expect(res.sampled).toBe(false);
    }
    expect(fake._batch.commit).not.toHaveBeenCalled();
  });

  it('logLlmCall: sample=1 → always queues', async () => {
    process.env.LLM_TELEMETRY_SAMPLE = '1';
    const fake = makeFakeFirestore({ stateDoc: { sampleRate: 1, changedAt: Date.now() } });
    patchFirestoreModule(fake);
    const mod = freshTelemetry();
    mod._testables.reset();

    for (let i = 0; i < 3; i++) {
      const res = await mod.logLlmCall({
        pipeline: 'chat-v3',
        scope: 'main',
        model: 'gemini-3.1-pro-preview-customtools',
        productId: `p${i}`,
      });
      expect(res.sampled).toBe(true);
    }
    expect(mod._testables.writer.queue.length).toBe(3);
  });

  it('logLlmCall: writes to Firestore via batched writer after explicit flush', async () => {
    process.env.LLM_TELEMETRY_SAMPLE = '1';
    const fake = makeFakeFirestore({ stateDoc: { sampleRate: 1, changedAt: Date.now() } });
    patchFirestoreModule(fake);
    const mod = freshTelemetry();
    mod._testables.reset();

    await mod.logLlmCall({
      pipeline: 'identify-v4',
      scope: 'identity-worker',
      model: 'gemini-3.1-pro-preview',
      promptTokens: 1000,
      completionTokens: 200,
      productId: 'abcXYZ',
      tenantId: 'tenant1',
      sampled: true,
    });
    expect(mod._testables.writer.queue.length).toBe(1);
    const result = await mod.flushBatch();
    expect(result.ok).toBe(true);
    expect(result.written).toBe(1);
    expect(fake._batch.set).toHaveBeenCalledTimes(1);
    expect(fake._batch.commit).toHaveBeenCalledTimes(1);
    // Payload sanity
    const payload = fake._batchOps[0].payload;
    expect(payload.pipeline).toBe('identify-v4');
    expect(payload.scope).toBe('identity-worker');
    expect(payload.tenantId).toBe('tenant1');
    expect(payload.costUsdEstimate).toBeGreaterThan(0);
    // _docId stripped from payload
    expect(payload._docId).toBeUndefined();
    expect(fake._batchOps[0].ref.id).toMatch(/^[0-9a-f]{8}-\d+-abcXYZ$/);
  });

  it('logLlmCall: NEVER throws even when Firestore.commit fails', async () => {
    const fake = makeFakeFirestore({
      stateDoc: { sampleRate: 1, changedAt: Date.now() },
      failBatchCommit: true,
    });
    patchFirestoreModule(fake);
    const mod = freshTelemetry();
    mod._testables.reset();

    await expect(
      mod.logLlmCall({
        pipeline: 'p',
        scope: 's',
        model: 'gemini-3.1-pro-preview',
        sampled: true,
      })
    ).resolves.toEqual(expect.objectContaining({ ok: true, sampled: true }));

    // Flush also must not throw
    const res = await mod.flushBatch();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('batch_error');
  });

  it('logLlmCall: NEVER throws when Firestore module itself throws on require', async () => {
    // Simulate firestore not loadable: leave cache deleted but module path will then truly require
    // → safer: patch with throwing getter
    const firestorePath = require.resolve('../../lib/firestore');
    require.cache[firestorePath] = {
      id: firestorePath,
      filename: firestorePath,
      loaded: true,
      // Throw if anyone accesses `.firestore`
      exports: new Proxy(
        {},
        {
          get() {
            throw new Error('module-explode');
          },
        }
      ),
    };
    const mod = freshTelemetry();
    mod._testables.reset();
    const res = await mod.logLlmCall({
      pipeline: 'p',
      scope: 's',
      model: 'gemini-3.1-pro-preview',
      sampled: true,
    });
    expect(res.ok).toBe(true);
  });

  it('getSampleRateFromState: caches result within TTL', async () => {
    const fake = makeFakeFirestore({ stateDoc: { sampleRate: 0.25, changedAt: Date.now() } });
    patchFirestoreModule(fake);
    const mod = freshTelemetry();
    mod._testables.reset();

    const a = await mod.getSampleRateFromState();
    const b = await mod.getSampleRateFromState();
    expect(a).toBe(0.25);
    expect(b).toBe(0.25);
    // get() called once because second call hit cache
    expect(fake._docRef.get).toHaveBeenCalledTimes(1);
  });

  it('getSampleRateFromState: triggers auto-downgrade after 24h at >0.5', async () => {
    const veryOld = Date.now() - 25 * 60 * 60 * 1000; // 25h ago
    const fake = makeFakeFirestore({ stateDoc: { sampleRate: 0.9, changedAt: veryOld } });
    patchFirestoreModule(fake);
    const mod = freshTelemetry();
    mod._testables.reset();

    const rate = await mod.getSampleRateFromState();
    expect(rate).toBe(0.1);
    expect(fake._docRef.set).toHaveBeenCalledTimes(1);
    const written = fake._writes[0].data;
    expect(written.sampleRate).toBe(0.1);
    expect(written.previousRate).toBe(0.9);
    expect(written.reason).toBe('auto_downgrade_24h');
  });

  it('getSampleRateFromState: no auto-downgrade when sampleRate <= threshold', async () => {
    const veryOld = Date.now() - 25 * 60 * 60 * 1000;
    const fake = makeFakeFirestore({ stateDoc: { sampleRate: 0.3, changedAt: veryOld } });
    patchFirestoreModule(fake);
    const mod = freshTelemetry();
    mod._testables.reset();
    const rate = await mod.getSampleRateFromState();
    expect(rate).toBe(0.3);
    expect(fake._docRef.set).not.toHaveBeenCalled();
  });

  it('getSampleRateFromState: falls back gracefully on Firestore read error', async () => {
    process.env.LLM_TELEMETRY_SAMPLE = '0.42';
    const fake = makeFakeFirestore({ failStateRead: true });
    patchFirestoreModule(fake);
    const mod = freshTelemetry();
    mod._testables.reset();
    const rate = await mod.getSampleRateFromState();
    expect(rate).toBe(0.42);
  });

  // ── CRITICAL-2 fix: ENV override must win over Firestore-state-doc value.
  //    Previously Firestore overwrote the ENV-supplied rate, making the ENV
  //    knob silently useless. ──────────────────────────────────────────────
  it('CRITICAL-2: ENV LLM_TELEMETRY_SAMPLE wins over Firestore sampleRate', async () => {
    process.env.LLM_TELEMETRY_SAMPLE = '0.0';
    const fake = makeFakeFirestore({
      // Firestore says 1.0 — but ENV explicitly says 0.0 → ENV wins.
      stateDoc: { sampleRate: 1.0, changedAt: Date.now() },
    });
    patchFirestoreModule(fake);
    const mod = freshTelemetry();
    mod._testables.reset();
    const rate = await mod.getSampleRateFromState();
    expect(rate).toBe(0);
  });

  it('CRITICAL-2: ENV LLM_TELEMETRY_SAMPLE=0.05 wins over Firestore sampleRate=0.9', async () => {
    process.env.LLM_TELEMETRY_SAMPLE = '0.05';
    const fake = makeFakeFirestore({
      stateDoc: { sampleRate: 0.9, changedAt: Date.now() },
    });
    patchFirestoreModule(fake);
    const mod = freshTelemetry();
    mod._testables.reset();
    const rate = await mod.getSampleRateFromState();
    expect(rate).toBe(0.05);
  });

  it('CRITICAL-2: Firestore sampleRate STILL applies when no ENV is set', async () => {
    delete process.env.LLM_TELEMETRY_SAMPLE;
    const fake = makeFakeFirestore({
      stateDoc: { sampleRate: 0.33, changedAt: Date.now() },
    });
    patchFirestoreModule(fake);
    const mod = freshTelemetry();
    mod._testables.reset();
    const rate = await mod.getSampleRateFromState();
    expect(rate).toBe(0.33);
  });

  // --- batched-writer behavior -----------------------------------------------

  it('batchedWriter: flushes automatically after 100 events', async () => {
    process.env.LLM_TELEMETRY_SAMPLE = '1';
    const fake = makeFakeFirestore({ stateDoc: { sampleRate: 1, changedAt: Date.now() } });
    patchFirestoreModule(fake);
    const mod = freshTelemetry();
    mod._testables.reset();

    const promises = [];
    for (let i = 0; i < 100; i++) {
      promises.push(
        mod.logLlmCall({
          pipeline: 'p',
          scope: 's',
          model: 'gemini-3.1-pro-preview',
          productId: `id${i}`,
          sampled: true,
        })
      );
    }
    await Promise.all(promises);
    // Size-trigger fired synchronously after the 100th enqueue; wait for microtask
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake._batch.commit).toHaveBeenCalledTimes(1);
    expect(fake._batchOps.length).toBe(100);
  });

  it('batchedWriter: flushes after timer when below batch size', async () => {
    vi.useFakeTimers();
    process.env.LLM_TELEMETRY_SAMPLE = '1';
    const fake = makeFakeFirestore({ stateDoc: { sampleRate: 1, changedAt: Date.now() } });
    patchFirestoreModule(fake);
    const mod = freshTelemetry();
    mod._testables.reset();

    await mod.logLlmCall({
      pipeline: 'p',
      scope: 's',
      model: 'gemini-3.1-pro-preview',
      sampled: true,
    });
    expect(fake._batch.commit).not.toHaveBeenCalled();
    expect(mod._testables.writer.queue.length).toBe(1);

    // Advance fake time past BATCH_FLUSH_MS (5000ms)
    await vi.advanceTimersByTimeAsync(mod._testables.BATCH_FLUSH_MS + 10);
    expect(fake._batch.commit).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // --- payload integrity -----------------------------------------------------

  it('logLlmCall: full payload contains all expected fields', async () => {
    const fake = makeFakeFirestore({ stateDoc: { sampleRate: 1, changedAt: Date.now() } });
    patchFirestoreModule(fake);
    const mod = freshTelemetry();
    mod._testables.reset();

    await mod.logLlmCall({
      pipeline: 'identify-v4',
      scope: 'pricing-worker',
      scopeVersion: 'v4',
      model: 'gemini-3.1-pro-preview',
      temperature: 0.4,
      outputQualityScore: 0.87,
      schemaValid: true,
      latencyMs: 1234,
      promptTokens: 800,
      completionTokens: 200,
      tenantId: 'trendocean',
      productId: 'sku123',
      sampled: true,
      timestamp: 1700000000000,
    });
    await mod.flushBatch();
    const payload = fake._batchOps[0].payload;
    expect(payload.pipeline).toBe('identify-v4');
    expect(payload.scope).toBe('pricing-worker');
    expect(payload.scopeVersion).toBe('v4');
    expect(payload.model).toBe('gemini-3.1-pro-preview');
    expect(payload.temperature).toBe(0.4);
    expect(payload.outputQualityScore).toBe(0.87);
    expect(payload.schemaValid).toBe(true);
    expect(payload.latencyMs).toBe(1234);
    expect(payload.promptTokens).toBe(800);
    expect(payload.completionTokens).toBe(200);
    expect(payload.tenantId).toBe('trendocean');
    expect(payload.productId).toBe('sku123');
    expect(payload.sampled).toBe('forced');
    expect(payload.sampleRateAtWrite).toBe(1);
    expect(payload.timestamp).toBe(1700000000000);
    expect(typeof payload.createdAt).toBe('string');
    expect(payload.costUsdEstimate).toBeGreaterThan(0);
  });

  it('logLlmCall: respects explicit costUsdEstimate override', async () => {
    const fake = makeFakeFirestore({ stateDoc: { sampleRate: 1, changedAt: Date.now() } });
    patchFirestoreModule(fake);
    const mod = freshTelemetry();
    mod._testables.reset();
    await mod.logLlmCall({
      pipeline: 'p',
      scope: 's',
      model: 'gemini-3.1-pro-preview',
      promptTokens: 999,
      completionTokens: 111,
      costUsdEstimate: 0.0042,
      sampled: true,
    });
    await mod.flushBatch();
    expect(fake._batchOps[0].payload.costUsdEstimate).toBe(0.0042);
  });
});
