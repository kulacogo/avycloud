// CommonJS. 2 Spaces. Single Quotes.
// Gemini Context Caching Wrapper.
// API-Referenz: https://ai.google.dev/gemini-api/docs/caching
// Pricing: https://ai.google.dev/gemini-api/docs/pricing  (cached input ~10% of normal)
//
// Zweck: System-Prompts bei wiederholten Calls (Bulk-Ops, Chat) auf Gemini-seitigen
// Context-Cache legen. Minimum 4096 Tokens. TTL updatebar. In-Process-LRU vermeidet
// redundante ai.caches.create()-Roundtrips innerhalb einer Prozess-Lebensdauer.

const crypto = require('node:crypto');

// In-Process-LRU (optional, reduziert API-Roundtrips — der echte Cache liegt bei Google)
const MEMORY_CACHE = new Map(); // cacheKey -> { name, model, expiresAt, createdAt, tokensEstimated }
const MEMORY_CACHE_MAX = 50;

const MIN_TOKENS = 4096; // Gemini harter Minimum
const DEFAULT_TTL_SECONDS = 3600; // 60min — matches most batch flows

/**
 * Stabile Cache-Key-Berechnung aus normalisiertem System-Instruction + Tools + Model.
 *
 * @param {{ model?: string, systemInstruction?: string, tools?: Array }} opts
 * @returns {string} 40-char sha256 prefix
 */
function computeCacheKey({ model, systemInstruction, tools } = {}) {
  const h = crypto.createHash('sha256');
  h.update(String(model || ''));
  h.update(' ');
  h.update(String(systemInstruction || ''));
  h.update(' ');
  h.update(JSON.stringify(tools || []));
  return h.digest('hex').slice(0, 40);
}

/**
 * Schätzt Token-Count grob (~4 chars/token für Deutsch/Englisch).
 * Für die Min-Check-Entscheidung ausreichend — exakte Zählung via Gemini countTokens kostet einen Call.
 *
 * @param {string|object} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (!text) return 0;
  const chars = typeof text === 'string' ? text.length : JSON.stringify(text).length;
  return Math.ceil(chars / 4);
}

/**
 * Evict oldest entry if MEMORY_CACHE exceeds MEMORY_CACHE_MAX (insertion-order LRU).
 */
function evictIfNeeded() {
  while (MEMORY_CACHE.size > MEMORY_CACHE_MAX) {
    const firstKey = MEMORY_CACHE.keys().next().value;
    if (firstKey === undefined) break;
    MEMORY_CACHE.delete(firstKey);
  }
}

/**
 * Erstellt oder wiederverwendet einen Gemini-Context-Cache.
 *
 * Wenn systemInstruction < MIN_TOKENS: returns { name: null, cached: false, reason: 'too_small' }
 * Wenn in-process cache einen gültigen Eintrag für den cacheKey hat: returns den.
 * Sonst: ai.caches.create() → speichert lokal + returniert name + meta.
 *
 * Best-effort: Jeder Fehler wird abgefangen — Caller fällt auf non-cached Config zurück.
 *
 * @param {object} opts
 * @param {object} opts.ai — @google/genai client instance (ai.caches.create(...) erwartet)
 * @param {string} opts.model
 * @param {string} opts.systemInstruction
 * @param {Array} [opts.tools]
 * @param {number} [opts.ttlSeconds]
 * @returns {Promise<{ name: string|null, cached: boolean, tokensEstimated: number, reason?: string, error?: string, meta?: object }>}
 */
async function getOrCreateCache(opts = {}) {
  const {
    ai,
    model,
    systemInstruction,
    tools = [],
    ttlSeconds = DEFAULT_TTL_SECONDS,
  } = opts;

  const tokensEstimated = estimateTokens(systemInstruction);

  if (tokensEstimated < MIN_TOKENS) {
    return { name: null, cached: false, tokensEstimated, reason: 'too_small' };
  }

  if (!ai || !ai.caches || typeof ai.caches.create !== 'function') {
    return {
      name: null,
      cached: false,
      tokensEstimated,
      reason: 'no_client',
    };
  }

  const key = computeCacheKey({ model, systemInstruction, tools });
  const now = Date.now();

  const existing = MEMORY_CACHE.get(key);
  if (existing && existing.expiresAt > now) {
    // Refresh LRU position (delete+set moves it to the end)
    MEMORY_CACHE.delete(key);
    MEMORY_CACHE.set(key, existing);
    return {
      name: existing.name,
      cached: true,
      tokensEstimated,
      reason: 'memory_hit',
      meta: {
        key,
        model: existing.model,
        expiresAt: existing.expiresAt,
        createdAt: existing.createdAt,
      },
    };
  }

  // Expired entry — evict
  if (existing) MEMORY_CACHE.delete(key);

  try {
    const created = await ai.caches.create({
      model,
      config: {
        systemInstruction,
        tools,
        ttl: `${ttlSeconds}s`,
      },
    });

    const name = created && (created.name || created.cachedContentName);
    if (!name) {
      return {
        name: null,
        cached: false,
        tokensEstimated,
        reason: 'no_name_returned',
      };
    }

    const entry = {
      name,
      model,
      createdAt: now,
      expiresAt: now + ttlSeconds * 1000,
      tokensEstimated,
    };
    MEMORY_CACHE.set(key, entry);
    evictIfNeeded();

    return {
      name,
      cached: false,
      tokensEstimated,
      reason: 'created',
      meta: { key, model, expiresAt: entry.expiresAt, createdAt: entry.createdAt },
    };
  } catch (err) {
    return {
      name: null,
      cached: false,
      tokensEstimated,
      reason: 'error',
      error: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * Listet aktive in-process cached entries (debugging/telemetry).
 * Expired Einträge werden herausgefiltert (nicht entfernt).
 *
 * @returns {Array<{ key: string, name: string, model: string, expiresAt: number, createdAt: number, tokensEstimated: number }>}
 */
function listActiveCaches() {
  const now = Date.now();
  const active = [];
  for (const [key, entry] of MEMORY_CACHE.entries()) {
    if (entry.expiresAt > now) active.push({ key, ...entry });
  }
  return active;
}

/**
 * Löscht einen cached name (lokal + remote) — nutze bei Prompt-Updates.
 *
 * @param {object} ai — @google/genai client
 * @param {string} key — cache key from computeCacheKey
 * @returns {Promise<{ ok: boolean, reason?: string, error?: string }>}
 */
async function invalidateCache(ai, key) {
  const entry = MEMORY_CACHE.get(key);
  if (!entry) return { ok: false, reason: 'not_in_memory' };
  MEMORY_CACHE.delete(key);
  if (!ai || !ai.caches || typeof ai.caches.delete !== 'function') {
    return { ok: false, reason: 'no_client' };
  }
  try {
    await ai.caches.delete({ name: entry.name });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Hilfe: Baut ein Config-Objekt für generateContent() das den cache verwendet wenn verfügbar.
 * Fallback: ohne cache (spread extraConfig only).
 *
 * @param {{ name: string|null }|null} cacheResult
 * @param {object} [extraConfig]
 * @returns {object}
 */
function buildCachedConfig(cacheResult, extraConfig = {}) {
  if (!cacheResult || !cacheResult.name) return { ...extraConfig };
  return { ...extraConfig, cachedContent: cacheResult.name };
}

/**
 * Feature-Flag-Check: respektiert ENV GEMINI_PROMPT_CACHE.
 * Default aktiv. Nur "false"/"0"/"no"/"off" deaktiviert.
 *
 * @returns {boolean}
 */
function promptCacheEnabled() {
  const raw = String(process.env.GEMINI_PROMPT_CACHE || '').trim().toLowerCase();
  return !['false', '0', 'no', 'off'].includes(raw);
}

module.exports = {
  MIN_TOKENS,
  DEFAULT_TTL_SECONDS,
  MEMORY_CACHE_MAX,
  computeCacheKey,
  estimateTokens,
  getOrCreateCache,
  invalidateCache,
  buildCachedConfig,
  listActiveCaches,
  promptCacheEnabled,
  _testables: { MEMORY_CACHE },
};
