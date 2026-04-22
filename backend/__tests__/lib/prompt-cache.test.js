// globals: true in vitest.config.js makes describe, it, expect, beforeEach, vi available globally.
// Pure unit tests — no GCP patching needed. We stub the `ai` client directly via a fake object.

const ORIGINAL_ENV = { ...process.env };

function freshRequire() {
  delete require.cache[require.resolve('../../lib/prompt-cache')];
  return require('../../lib/prompt-cache');
}

/**
 * Build a stub ai client where ai.caches.create() returns a predictable name.
 * Pass { failOnCreate: true } to make create() throw.
 */
function makeStubAi({ name = 'cachedContents/abc123', failOnCreate = false, failOnDelete = false } = {}) {
  return {
    caches: {
      create: vi.fn(async () => {
        if (failOnCreate) throw new Error('boom-create');
        return { name };
      }),
      delete: vi.fn(async () => {
        if (failOnDelete) throw new Error('boom-delete');
        return {};
      }),
    },
  };
}

/** Build a system-instruction string large enough to pass MIN_TOKENS (~4096 tokens ≈ 16400 chars). */
function bigPrompt(chars = 20000) {
  return 'x'.repeat(chars);
}

describe('prompt-cache', () => {
  beforeEach(() => {
    // Reset ENV
    delete process.env.GEMINI_PROMPT_CACHE;
    // Clear in-memory cache between tests by freshly requiring the module
    const mod = freshRequire();
    mod._testables.MEMORY_CACHE.clear();
  });

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  // 1
  it('computeCacheKey returns stable hash for identical inputs', () => {
    const { computeCacheKey } = freshRequire();
    const a = computeCacheKey({ model: 'gemini-3.1-pro', systemInstruction: 'hello', tools: [{ googleSearch: {} }] });
    const b = computeCacheKey({ model: 'gemini-3.1-pro', systemInstruction: 'hello', tools: [{ googleSearch: {} }] });
    expect(a).toBe(b);
    expect(typeof a).toBe('string');
    expect(a.length).toBe(40);
  });

  // 2
  it('computeCacheKey differs when model, instruction, or tools change', () => {
    const { computeCacheKey } = freshRequire();
    const base = computeCacheKey({ model: 'gemini-3.1-pro', systemInstruction: 'hello', tools: [] });
    const other1 = computeCacheKey({ model: 'gemini-3-flash', systemInstruction: 'hello', tools: [] });
    const other2 = computeCacheKey({ model: 'gemini-3.1-pro', systemInstruction: 'different', tools: [] });
    const other3 = computeCacheKey({ model: 'gemini-3.1-pro', systemInstruction: 'hello', tools: [{ googleSearch: {} }] });
    expect(base).not.toBe(other1);
    expect(base).not.toBe(other2);
    expect(base).not.toBe(other3);
  });

  // 3
  it('estimateTokens returns reasonable values (≈4 chars/token)', () => {
    const { estimateTokens } = freshRequire();
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    // 'hello world' = 11 chars => ceil(11/4) = 3
    expect(estimateTokens('hello world')).toBe(3);
    // 4096 chars = exactly 1024 tokens
    expect(estimateTokens('a'.repeat(4096))).toBe(1024);
    // Object is stringified, so length will be JSON length
    const obj = { a: 'hello world' };
    expect(estimateTokens(obj)).toBe(Math.ceil(JSON.stringify(obj).length / 4));
  });

  // 4
  it('getOrCreateCache returns { cached: false, reason: too_small } when below MIN_TOKENS', async () => {
    const { getOrCreateCache } = freshRequire();
    const ai = makeStubAi();
    const result = await getOrCreateCache({
      ai,
      model: 'gemini-3.1-pro-preview',
      systemInstruction: 'short prompt',
      tools: [],
    });
    expect(result.name).toBeNull();
    expect(result.cached).toBe(false);
    expect(result.reason).toBe('too_small');
    expect(ai.caches.create).not.toHaveBeenCalled();
  });

  // 5
  it('getOrCreateCache creates cache when size sufficient (calls ai.caches.create)', async () => {
    const { getOrCreateCache } = freshRequire();
    const ai = makeStubAi({ name: 'cachedContents/fresh-1' });
    const result = await getOrCreateCache({
      ai,
      model: 'gemini-3.1-pro-preview',
      systemInstruction: bigPrompt(),
      tools: [],
      ttlSeconds: 1800,
    });
    expect(result.name).toBe('cachedContents/fresh-1');
    expect(result.cached).toBe(false);
    expect(result.reason).toBe('created');
    expect(ai.caches.create).toHaveBeenCalledOnce();
    const callArg = ai.caches.create.mock.calls[0][0];
    expect(callArg.model).toBe('gemini-3.1-pro-preview');
    expect(callArg.config.ttl).toBe('1800s');
    expect(callArg.config.systemInstruction.length).toBeGreaterThan(16000);
  });

  // 6
  it('getOrCreateCache returns memory-hit on second call with same key', async () => {
    const { getOrCreateCache } = freshRequire();
    const ai = makeStubAi({ name: 'cachedContents/reuse-1' });

    const first = await getOrCreateCache({
      ai,
      model: 'gemini-3.1-pro-preview',
      systemInstruction: bigPrompt(),
      tools: [],
    });
    expect(first.reason).toBe('created');

    const second = await getOrCreateCache({
      ai,
      model: 'gemini-3.1-pro-preview',
      systemInstruction: bigPrompt(),
      tools: [],
    });
    expect(second.name).toBe('cachedContents/reuse-1');
    expect(second.cached).toBe(true);
    expect(second.reason).toBe('memory_hit');
    // create() should only have been called once
    expect(ai.caches.create).toHaveBeenCalledOnce();
  });

  // 7
  it('getOrCreateCache does NOT return memory-hit if the in-memory entry is expired', async () => {
    const mod = freshRequire();
    const { getOrCreateCache, computeCacheKey, _testables } = mod;
    const instruction = bigPrompt();
    const model = 'gemini-3.1-pro-preview';
    const key = computeCacheKey({ model, systemInstruction: instruction, tools: [] });

    // Seed expired entry
    _testables.MEMORY_CACHE.set(key, {
      name: 'cachedContents/old',
      model,
      createdAt: Date.now() - 10_000,
      expiresAt: Date.now() - 1000, // already expired
      tokensEstimated: 5000,
    });

    const ai = makeStubAi({ name: 'cachedContents/new' });
    const result = await getOrCreateCache({
      ai,
      model,
      systemInstruction: instruction,
      tools: [],
    });
    expect(result.reason).toBe('created');
    expect(result.name).toBe('cachedContents/new');
    expect(ai.caches.create).toHaveBeenCalledOnce();
  });

  // 8
  it('invalidateCache removes from memory and calls ai.caches.delete', async () => {
    const mod = freshRequire();
    const { invalidateCache, _testables } = mod;
    const key = 'test-key-42';
    _testables.MEMORY_CACHE.set(key, {
      name: 'cachedContents/kill-me',
      model: 'gemini-3.1-pro',
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      tokensEstimated: 5000,
    });
    const ai = makeStubAi();
    const out = await invalidateCache(ai, key);
    expect(out.ok).toBe(true);
    expect(_testables.MEMORY_CACHE.has(key)).toBe(false);
    expect(ai.caches.delete).toHaveBeenCalledWith({ name: 'cachedContents/kill-me' });

    // Second call: not in memory -> ok:false
    const again = await invalidateCache(ai, key);
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('not_in_memory');
  });

  // 9
  it('buildCachedConfig adds cachedContent when cacheResult has a name', () => {
    const { buildCachedConfig } = freshRequire();
    const out = buildCachedConfig({ name: 'cachedContents/xyz' }, { temperature: 0.4 });
    expect(out).toEqual({ temperature: 0.4, cachedContent: 'cachedContents/xyz' });
  });

  // 10
  it('buildCachedConfig does NOT add cachedContent when name is null or result missing', () => {
    const { buildCachedConfig } = freshRequire();
    const a = buildCachedConfig({ name: null }, { temperature: 0.4 });
    expect(a).toEqual({ temperature: 0.4 });
    expect(a.cachedContent).toBeUndefined();

    const b = buildCachedConfig(null, { maxOutputTokens: 1024 });
    expect(b).toEqual({ maxOutputTokens: 1024 });

    const c = buildCachedConfig(undefined);
    expect(c).toEqual({});
  });

  // 11
  it('listActiveCaches filters out expired entries', () => {
    const mod = freshRequire();
    const { listActiveCaches, _testables } = mod;
    const now = Date.now();
    _testables.MEMORY_CACHE.set('alive', {
      name: 'cachedContents/alive',
      model: 'x',
      createdAt: now,
      expiresAt: now + 60_000,
      tokensEstimated: 5000,
    });
    _testables.MEMORY_CACHE.set('dead', {
      name: 'cachedContents/dead',
      model: 'x',
      createdAt: now - 120_000,
      expiresAt: now - 1000,
      tokensEstimated: 5000,
    });
    const active = listActiveCaches();
    expect(active).toHaveLength(1);
    expect(active[0].key).toBe('alive');
    expect(active[0].name).toBe('cachedContents/alive');
  });

  // 12
  it('promptCacheEnabled respects ENV var (false/0/no/off disable)', () => {
    for (const val of ['false', '0', 'no', 'off', 'FALSE', 'Off']) {
      process.env.GEMINI_PROMPT_CACHE = val;
      const { promptCacheEnabled } = freshRequire();
      expect(promptCacheEnabled()).toBe(false);
    }
    for (const val of ['', 'true', '1', 'yes', 'on', 'enabled']) {
      process.env.GEMINI_PROMPT_CACHE = val;
      const { promptCacheEnabled } = freshRequire();
      expect(promptCacheEnabled()).toBe(true);
    }
    // Unset -> default enabled
    delete process.env.GEMINI_PROMPT_CACHE;
    const { promptCacheEnabled } = freshRequire();
    expect(promptCacheEnabled()).toBe(true);
  });

  // Bonus: error path coverage (getOrCreateCache swallows errors)
  it('getOrCreateCache returns { reason: error } when ai.caches.create throws', async () => {
    const { getOrCreateCache } = freshRequire();
    const ai = makeStubAi({ failOnCreate: true });
    const result = await getOrCreateCache({
      ai,
      model: 'gemini-3.1-pro-preview',
      systemInstruction: bigPrompt(),
      tools: [],
    });
    expect(result.name).toBeNull();
    expect(result.cached).toBe(false);
    expect(result.reason).toBe('error');
    expect(result.error).toContain('boom-create');
  });

  // Bonus: no-client path (ai missing caches)
  it('getOrCreateCache returns { reason: no_client } when ai has no caches API', async () => {
    const { getOrCreateCache } = freshRequire();
    const result = await getOrCreateCache({
      ai: {}, // no caches field
      model: 'gemini-3.1-pro-preview',
      systemInstruction: bigPrompt(),
      tools: [],
    });
    expect(result.name).toBeNull();
    expect(result.reason).toBe('no_client');
  });
});
