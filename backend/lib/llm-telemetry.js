/**
 * LLM-Telemetry-Logger.
 *
 * Zentraler Helper für LLM-Call-Telemetrie. Wird (in Sprint 8 / F.4-Migration)
 * von allen LLM-Pipelines (identify-v3/v4, chat-v2/v3, atomic-tools) aufgerufen.
 *
 * Schreibt Events in Firestore-Collection `llm_call_telemetry` mit:
 *   - Sample-Rate (default 0.1, ENV LLM_TELEMETRY_SAMPLE)
 *   - Auto-Downgrade nach 24h bei sample > 0.5 (verhindert versehentlich teure Long-Term-Sampling-Runs)
 *   - Doc-ID-Sharding (`${random8}-${ts}-${productId}`) gegen Firestore-Hotspots
 *   - In-Memory-Batched-Writer (flush alle 5s ODER bei 100 Events)
 *
 * Defensiv: Wirft NIEMALS. Telemetry darf die Hauptpipeline nicht crashen.
 *
 * Siehe Plan F.4a, Vorbild: `lib/stock-change-events.js` + `lib/prompt-cache.js`.
 */

'use strict';

const crypto = require('crypto');

const SAMPLE_ENV = 'LLM_TELEMETRY_SAMPLE';
const STATE_DOC_PATH = 'system/llm-telemetry-state';
const COLLECTION = 'llm_call_telemetry';
const STATE_CACHE_TTL_MS = 60_000;
const AUTO_DOWNGRADE_AFTER_MS = 24 * 60 * 60 * 1000;
const AUTO_DOWNGRADE_THRESHOLD = 0.5;
const AUTO_DOWNGRADE_TARGET = 0.1;

const BATCH_FLUSH_MS = 5_000;
const BATCH_MAX_SIZE = 100;

// --- Pricing-Table (USD per 1M tokens, Approximation Mai 2026) ----------------
// Wird primär für Cost-Estimation verwendet. Bewusst eigene Quelle weil
// `gemini-config.js` keine Preise exposed. Werte konservativ (Listen-Preise),
// nicht für Buchhaltung — nur für Telemetrie-Aggregate.
const MODEL_PRICING_USD_PER_M = Object.freeze({
  // Politik-Modell seit 2026-08-26 (Aktionspreis bis 31.12.2026, danach 1.50/7.50
  // laut ai.google.dev/gemini-api/docs/pricing — Eintrag dann nachziehen)
  'gemini-3.7-flash': { input: 0.75, output: 3.75 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75 },
  'gemini-3.5-flash': { input: 1.5, output: 9.0 },
  // Gemini 3 family
  'gemini-3.1-pro-preview-customtools': { input: 1.25, output: 5.0 },
  'gemini-3.1-pro-preview': { input: 1.25, output: 5.0 },
  'gemini-3-pro-preview': { input: 1.25, output: 5.0 },
  'gemini-3-pro-image-preview': { input: 1.25, output: 5.0 },
  'gemini-3-flash-preview': { input: 0.10, output: 0.40 },
  // Gemini 2.x fallback
  'gemini-2.5-pro': { input: 1.25, output: 5.0 },
  'gemini-2.5-flash': { input: 0.10, output: 0.40 },
  // Generic fallback
  __default: { input: 0.50, output: 2.0 },
});

function getPricingForModel(model) {
  if (!model) return MODEL_PRICING_USD_PER_M.__default;
  if (MODEL_PRICING_USD_PER_M[model]) return MODEL_PRICING_USD_PER_M[model];
  // Heuristik: flash-Modelle billiger
  if (/flash/i.test(model)) {
    return MODEL_PRICING_USD_PER_M['gemini-3-flash-preview'];
  }
  if (/pro|customtools/i.test(model)) {
    return MODEL_PRICING_USD_PER_M['gemini-3.1-pro-preview'];
  }
  return MODEL_PRICING_USD_PER_M.__default;
}

/**
 * Approximation der USD-Kosten eines LLM-Calls.
 * Returns immer eine non-negative Zahl. Bei missing tokens → 0.
 */
function estimateCostUsd({ model, promptTokens, completionTokens } = {}) {
  const pricing = getPricingForModel(model);
  const inT = Math.max(0, Number(promptTokens) || 0);
  const outT = Math.max(0, Number(completionTokens) || 0);
  const cost = (inT / 1_000_000) * pricing.input + (outT / 1_000_000) * pricing.output;
  if (!Number.isFinite(cost) || cost < 0) return 0;
  // Auf 8 Nachkommastellen runden, sonst entstehen 0.000000001-Artefakte
  return Math.round(cost * 1e8) / 1e8;
}

// --- Sample-Rate-State (mit 60s in-process-Cache) -----------------------------

const _stateCache = {
  value: null,
  loadedAt: 0,
};

function _now() {
  return Date.now();
}

function _envSample() {
  const raw = process.env[SAMPLE_ENV];
  if (raw === undefined || raw === null || raw === '') return null;
  const num = Number(raw);
  if (!Number.isFinite(num)) return null;
  if (num < 0) return 0;
  if (num > 1) return 1;
  return num;
}

function _getFirestore() {
  try {
    const mod = require('./firestore');
    return mod.firestore || null;
  } catch (err) {
    console.warn(`[llm-telemetry] firestore require failed: ${err.message}`);
    return null;
  }
}

/**
 * Liest Sample-Rate aus Firestore-State (mit 60s-Cache).
 * Bei sampleRate > 0.5 UND age > 24h → Auto-Downgrade auf 0.1.
 *
 * Defensive: Bei ANY Error → ENV-Fallback bzw. Default 0.1.
 */
async function getSampleRateFromState({ now = _now() } = {}) {
  // 1) Cache-Hit?
  if (_stateCache.value && now - _stateCache.loadedAt < STATE_CACHE_TTL_MS) {
    return _stateCache.value;
  }

  // 2) ENV-Override priorisieren
  const envOverride = _envSample();

  // 3) Firestore lesen
  const db = _getFirestore();
  if (!db) {
    const fallback = envOverride !== null ? envOverride : 0.1;
    _stateCache.value = fallback;
    _stateCache.loadedAt = now;
    return fallback;
  }

  try {
    const ref = db.doc(STATE_DOC_PATH);
    const snap = await ref.get();
    // ENV-Override gewinnt IMMER. Firestore-Wert nur konsultieren wenn
    // kein ENV gesetzt ist — sonst kann ein versehentlich gepflegtes
    // Firestore-Doc den explizit gesetzten ENV-Wert überstimmen
    // (CRITICAL-2 cross-check fix).
    let sampleRate = envOverride !== null ? envOverride : 0.1;
    let changedAt = now;

    if (snap.exists) {
      const data = snap.data() || {};
      if (
        envOverride === null &&
        typeof data.sampleRate === 'number' &&
        Number.isFinite(data.sampleRate)
      ) {
        sampleRate = Math.max(0, Math.min(1, data.sampleRate));
      }
      // changedAt bleibt aus Firestore lesbar (auch wenn ENV gewinnt),
      // damit der Auto-Downgrade-Pfad weiterhin sinnvoll triggern kann
      // falls Firestore-Wert irgendwann doch greift.
      if (typeof data.changedAt === 'number' && Number.isFinite(data.changedAt)) {
        changedAt = data.changedAt;
      } else if (data.changedAt && typeof data.changedAt.toMillis === 'function') {
        changedAt = data.changedAt.toMillis();
      }
    }

    // Auto-Downgrade-Check
    if (sampleRate > AUTO_DOWNGRADE_THRESHOLD && now - changedAt > AUTO_DOWNGRADE_AFTER_MS) {
      console.warn(
        `[llm-telemetry] auto-downgrade: sampleRate=${sampleRate} aged ${Math.round(
          (now - changedAt) / 3600_000
        )}h → downgrading to ${AUTO_DOWNGRADE_TARGET}`
      );
      try {
        await ref.set(
          {
            sampleRate: AUTO_DOWNGRADE_TARGET,
            changedAt: now,
            previousRate: sampleRate,
            reason: 'auto_downgrade_24h',
          },
          { merge: true }
        );
      } catch (err) {
        console.warn(`[llm-telemetry] auto-downgrade write failed: ${err.message}`);
      }
      sampleRate = AUTO_DOWNGRADE_TARGET;
    }

    _stateCache.value = sampleRate;
    _stateCache.loadedAt = now;
    return sampleRate;
  } catch (err) {
    console.warn(`[llm-telemetry] state read failed: ${err.message}`);
    const fallback = envOverride !== null ? envOverride : 0.1;
    _stateCache.value = fallback;
    _stateCache.loadedAt = now;
    return fallback;
  }
}

// --- Doc-ID-Sharding ----------------------------------------------------------

function buildDocId(productId) {
  const random8 = crypto.randomBytes(4).toString('hex'); // 8 hex chars
  const ts = Date.now();
  const safeProd = String(productId || 'noprod').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'noprod';
  return `${random8}-${ts}-${safeProd}`;
}

// --- Batched Writer -----------------------------------------------------------

const _writerState = {
  queue: [],
  timer: null,
  exitHooked: false,
};

function _scheduleFlush() {
  if (_writerState.timer) return;
  _writerState.timer = setTimeout(() => {
    _writerState.timer = null;
    flushBatch().catch((err) => {
      console.warn(`[llm-telemetry] scheduled flush failed: ${err.message}`);
    });
  }, BATCH_FLUSH_MS);
  // Allow process to exit naturally
  if (_writerState.timer && typeof _writerState.timer.unref === 'function') {
    _writerState.timer.unref();
  }
}

function _installExitHookOnce() {
  if (_writerState.exitHooked) return;
  _writerState.exitHooked = true;
  const handler = () => {
    flushBatch().catch(() => {});
  };
  try {
    process.once('beforeExit', handler);
    process.once('SIGTERM', handler);
    process.once('SIGINT', handler);
  } catch (_err) {
    /* not a real process env (e.g. test isolation) — ignore */
  }
}

async function flushBatch() {
  if (_writerState.queue.length === 0) return { ok: true, written: 0 };
  const drained = _writerState.queue.splice(0, _writerState.queue.length);

  const db = _getFirestore();
  if (!db) {
    // Firestore unavailable — drop events (best-effort)
    return { ok: false, written: 0, reason: 'no_firestore', dropped: drained.length };
  }

  try {
    const batch = db.batch();
    for (const evt of drained) {
      const ref = db.collection(COLLECTION).doc(evt._docId);
      const { _docId: _omit, ...payload } = evt;
      batch.set(ref, payload);
    }
    await batch.commit();
    return { ok: true, written: drained.length };
  } catch (err) {
    console.warn(`[llm-telemetry] batch commit failed (${drained.length} events): ${err.message}`);
    return { ok: false, written: 0, reason: 'batch_error', error: err.message, dropped: drained.length };
  }
}

function _enqueue(event) {
  _writerState.queue.push(event);
  _installExitHookOnce();
  if (_writerState.queue.length >= BATCH_MAX_SIZE) {
    // Flush sync-ish (no await needed by caller)
    if (_writerState.timer) {
      clearTimeout(_writerState.timer);
      _writerState.timer = null;
    }
    flushBatch().catch((err) => {
      console.warn(`[llm-telemetry] size-trigger flush failed: ${err.message}`);
    });
    return;
  }
  _scheduleFlush();
}

// --- Public API ---------------------------------------------------------------

/**
 * Logge einen LLM-Call. Async, aber wirft niemals.
 *
 * @param {Object} opts
 * @param {string} opts.pipeline             z.B. 'identify-v3', 'chat-v3', 'atomic-tools'
 * @param {string} opts.scope                Worker-/Stage-Name z.B. 'stage3', 'identity-worker'
 * @param {string} [opts.scopeVersion]       'v3', 'v4' etc.
 * @param {string} opts.model                Gemini-Model-Name
 * @param {number} [opts.temperature]
 * @param {number} [opts.outputQualityScore] 0..1 (z.B. confidence)
 * @param {boolean} [opts.schemaValid]
 * @param {number} [opts.latencyMs]
 * @param {number} [opts.promptTokens]
 * @param {number} [opts.completionTokens]
 * @param {number} [opts.costUsdEstimate]    Falls Caller selbst rechnen will (sonst auto via tokens)
 * @param {string} [opts.tenantId]
 * @param {string} [opts.productId]
 * @param {boolean} [opts.sampled]           Bypass sample-rate (für force-log)
 * @param {number}  [opts.timestamp]         Override (für Tests)
 */
async function logLlmCall(opts = {}) {
  try {
    const {
      pipeline = 'unknown',
      scope = 'unknown',
      scopeVersion = null,
      model = 'unknown',
      temperature = null,
      outputQualityScore = null,
      schemaValid = null,
      latencyMs = null,
      promptTokens = null,
      completionTokens = null,
      costUsdEstimate: explicitCost,
      tenantId = 'default',
      productId = null,
      sampled,
      timestamp,
    } = opts;

    // Sample-Decision: caller-supplied wins, sonst sample-rate gate
    const rate = await getSampleRateFromState();
    const forced = typeof sampled === 'boolean' ? sampled : null;
    const shouldLog =
      forced === true || (forced !== false && (rate >= 1 || (rate > 0 && Math.random() <= rate)));

    if (!shouldLog) return { ok: true, sampled: false };

    const cost =
      Number.isFinite(explicitCost) && explicitCost >= 0
        ? explicitCost
        : estimateCostUsd({ model, promptTokens, completionTokens });

    const event = {
      _docId: buildDocId(productId),
      pipeline,
      scope,
      scopeVersion,
      model,
      temperature,
      outputQualityScore,
      schemaValid,
      latencyMs,
      promptTokens,
      completionTokens,
      costUsdEstimate: cost,
      tenantId,
      productId,
      sampled: forced === true ? 'forced' : 'random',
      sampleRateAtWrite: rate,
      timestamp: typeof timestamp === 'number' ? timestamp : Date.now(),
      createdAt: new Date().toISOString(),
    };

    _enqueue(event);
    return { ok: true, sampled: true, queued: _writerState.queue.length };
  } catch (err) {
    // NEVER throw — telemetry must not break the host pipeline.
    try {
      console.warn(`[llm-telemetry] logLlmCall failed: ${err && err.message}`);
    } catch (_e) {
      /* noop */
    }
    return { ok: false, error: err && err.message };
  }
}

// --- Test-Helpers (nicht in normalem Codepfad) --------------------------------

function _resetStateForTests() {
  _stateCache.value = null;
  _stateCache.loadedAt = 0;
  _writerState.queue.length = 0;
  if (_writerState.timer) {
    clearTimeout(_writerState.timer);
    _writerState.timer = null;
  }
}

module.exports = {
  logLlmCall,
  getSampleRateFromState,
  flushBatch,
  estimateCostUsd,
  buildDocId,
  MODEL_PRICING_USD_PER_M,
  // Test surface
  _testables: {
    state: _stateCache,
    writer: _writerState,
    reset: _resetStateForTests,
    BATCH_FLUSH_MS,
    BATCH_MAX_SIZE,
    STATE_CACHE_TTL_MS,
    AUTO_DOWNGRADE_AFTER_MS,
    AUTO_DOWNGRADE_THRESHOLD,
    AUTO_DOWNGRADE_TARGET,
    COLLECTION,
  },
};
