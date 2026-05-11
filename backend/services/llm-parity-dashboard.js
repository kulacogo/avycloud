'use strict';

/**
 * llm-parity-dashboard.js — Aggregates `llm_call_telemetry` events into a
 * per-pipeline-per-domain parity view for the Admin LLM-Quality-Parity
 * endpoint (Plan F.4b).
 *
 * Reads the same collection that `lib/llm-telemetry.js` writes. Filters by
 * tenantId + optional date-range + optional pipeline. Aggregates means of
 * `outputQualityScore`, `latencyMs`, `costUsdEstimate`, and counts events.
 *
 * Drift-Detection: for each domain (scope) that surfaces in multiple
 * pipelines, compute the quality-gap between the highest- and lowest-mean
 * pipeline. Emit an alert if the gap exceeds `DEFAULT_DRIFT_THRESHOLD`
 * (configurable via `LLM_PARITY_DRIFT_THRESHOLD`).
 *
 * Pure read-path — never mutates Firestore.
 */

const { firestore } = require('../lib/firestore');

const COLLECTION = 'llm_call_telemetry';
const DEFAULT_HARD_CAP = 5000;
const DEFAULT_DRIFT_THRESHOLD = 0.15;

function envDriftThreshold() {
  const raw = process.env.LLM_PARITY_DRIFT_THRESHOLD;
  if (!raw) return DEFAULT_DRIFT_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return DEFAULT_DRIFT_THRESHOLD;
  return n;
}

function isoToTimestampMs(v) {
  if (!v) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function pushMean(acc, key, value) {
  if (!Number.isFinite(value)) return;
  const slot = acc.get(key) || { sum: 0, count: 0 };
  slot.sum += value;
  slot.count += 1;
  acc.set(key, slot);
}

function meanOrNull(slot) {
  if (!slot || slot.count <= 0) return null;
  return slot.sum / slot.count;
}

function round4(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10000) / 10000;
}

/**
 * listLlmParity(opts) — pipeline+domain aggregates and drift alerts.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId           MANDATORY tenant filter
 * @param {string} [opts.domain]           Filter to one scope (worker/stage name)
 * @param {string} [opts.dateFrom]         ISO inclusive lower bound for `timestamp` (ms)
 * @param {string} [opts.dateTo]           ISO inclusive upper bound for `timestamp` (ms)
 * @param {string} [opts.pipeline]         Filter to one pipeline (identify-v3, identify-v4, chat-v3, ...)
 * @returns {Promise<{ pipelines: Array, drift_alerts: Array, total: number, hard_cap: number }>}
 */
async function listLlmParity(opts = {}) {
  const tenantId = opts && typeof opts.tenantId === 'string' ? opts.tenantId.trim() : '';
  if (!tenantId) {
    const err = new Error('tenantId required');
    err.statusCode = 400;
    err.code = 'BAD_REQUEST';
    throw err;
  }

  const domain = opts.domain && typeof opts.domain === 'string' ? opts.domain.trim() : '';
  const pipelineFilter = opts.pipeline && typeof opts.pipeline === 'string' ? opts.pipeline.trim() : '';
  const dateFromMs = isoToTimestampMs(opts.dateFrom);
  const dateToMs = isoToTimestampMs(opts.dateTo);

  let query = firestore.collection(COLLECTION).where('tenantId', '==', tenantId);
  if (dateFromMs != null) query = query.where('timestamp', '>=', dateFromMs);
  if (dateToMs != null) query = query.where('timestamp', '<=', dateToMs);

  let snap;
  try {
    snap = await query.limit(DEFAULT_HARD_CAP).get();
  } catch (err) {
    const wrapped = new Error(`Failed to query llm_call_telemetry: ${err && err.message}`);
    wrapped.cause = err;
    throw wrapped;
  }

  const events = [];
  if (snap && typeof snap.forEach === 'function') {
    snap.forEach((doc) => {
      const data = (doc && typeof doc.data === 'function') ? doc.data() : doc;
      if (data) events.push(data);
    });
  }

  // Aggregate per (pipeline, domain).
  const qualityAcc = new Map(); // key: `${pipeline}|${scope}` → {sum, count}
  const latencyAcc = new Map();
  const costAcc = new Map();
  const counts = new Map();
  const meta = new Map(); // key → { pipeline, domain, models: Set<string> }

  for (const evt of events) {
    const pipeline = typeof evt?.pipeline === 'string' ? evt.pipeline : 'unknown';
    const scope = typeof evt?.scope === 'string' ? evt.scope : 'unknown';
    if (pipelineFilter && pipeline !== pipelineFilter) continue;
    if (domain && scope !== domain) continue;

    const key = `${pipeline}|${scope}`;
    pushMean(qualityAcc, key, Number(evt?.outputQualityScore));
    pushMean(latencyAcc, key, Number(evt?.latencyMs));
    pushMean(costAcc, key, Number(evt?.costUsdEstimate));
    counts.set(key, (counts.get(key) || 0) + 1);
    const m = meta.get(key) || { pipeline, domain: scope, models: new Set() };
    if (typeof evt?.model === 'string' && evt.model) m.models.add(evt.model);
    meta.set(key, m);
  }

  const pipelines = [];
  for (const [key, count] of counts.entries()) {
    const m = meta.get(key);
    pipelines.push({
      pipeline: m.pipeline,
      domain: m.domain,
      mean_quality: round4(meanOrNull(qualityAcc.get(key))),
      mean_latency_ms: round4(meanOrNull(latencyAcc.get(key))),
      mean_cost_usd: round4(meanOrNull(costAcc.get(key))),
      count,
      models: Array.from(m.models).slice(0, 8),
    });
  }

  // Drift-Detection: for each domain present in ≥2 pipelines, compute
  // max-min quality gap. Alert when gap > threshold.
  const driftThreshold = envDriftThreshold();
  const byDomain = new Map();
  for (const row of pipelines) {
    if (row.mean_quality == null) continue;
    const arr = byDomain.get(row.domain) || [];
    arr.push(row);
    byDomain.set(row.domain, arr);
  }

  const drift_alerts = [];
  for (const [dom, rows] of byDomain.entries()) {
    if (rows.length < 2) continue;
    let best = rows[0];
    let worst = rows[0];
    for (const r of rows) {
      if (r.mean_quality > best.mean_quality) best = r;
      if (r.mean_quality < worst.mean_quality) worst = r;
    }
    const gap = best.mean_quality - worst.mean_quality;
    if (gap > driftThreshold) {
      drift_alerts.push({
        domain: dom,
        gap: round4(gap),
        best_pipeline: best.pipeline,
        best_mean_quality: best.mean_quality,
        worst_pipeline: worst.pipeline,
        worst_mean_quality: worst.mean_quality,
        threshold: driftThreshold,
      });
    }
  }

  // Stable order for UI: by pipeline asc, then domain asc.
  pipelines.sort((a, b) => {
    if (a.pipeline === b.pipeline) return a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0;
    return a.pipeline < b.pipeline ? -1 : 1;
  });
  drift_alerts.sort((a, b) => (b.gap || 0) - (a.gap || 0));

  return {
    pipelines,
    drift_alerts,
    total: events.length,
    hard_cap: DEFAULT_HARD_CAP,
  };
}

module.exports = {
  listLlmParity,
  _internal: { COLLECTION, DEFAULT_HARD_CAP, DEFAULT_DRIFT_THRESHOLD },
};
