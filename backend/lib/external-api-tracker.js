'use strict';

const { firestore } = require('./firestore');
const logger = require('./logger');

const TRACKER_COLLECTION = 'external_api_calls';

// Sampling guard: in busy periods (e.g. price refresh scripts hammering SerpAPI) we
// don't want one Firestore write per call. Default samples 100% — operators can
// dial down via EXTERNAL_API_TRACKER_SAMPLE_RATE=0.1 once enough data is in.
function shouldRecord() {
  const raw = process.env.EXTERNAL_API_TRACKER_SAMPLE_RATE;
  if (!raw) return true;
  const rate = parseFloat(raw);
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (rate >= 1) return true;
  return Math.random() < rate;
}

/**
 * Fire-and-forget tracker for external HTTP services (SerpAPI, BrightData, …).
 * Records: which service, which endpoint, success/failure, latency, error code.
 * NEVER throws and never blocks the caller — same contract as identify-metrics.
 */
async function trackExternalCall({
  service,
  endpoint = null,
  success,
  latencyMs,
  errorCode = null,
  errorMessage = null,
  tenantId = 'default',
} = {}) {
  if (!shouldRecord()) return;
  try {
    await firestore.collection(TRACKER_COLLECTION).add({
      tenantId,
      timestamp: new Date(),
      service: String(service || 'unknown'),
      endpoint: endpoint ? String(endpoint).slice(0, 200) : null,
      success: Boolean(success),
      latencyMs: Number(latencyMs) || 0,
      errorCode: errorCode ? String(errorCode).slice(0, 100) : null,
      errorMessage: errorMessage ? String(errorMessage).slice(0, 300) : null,
    });
  } catch (err) {
    logger.warn({ err: err?.message }, '[external-api-tracker] failed to write');
  }
}

/**
 * Wrap an async call with tracking. Returns the wrapped result unchanged on success;
 * re-throws on failure (after recording). Use this around every BrightData / SerpAPI
 * invocation so we get usage data without modifying the call shape itself.
 */
async function instrumentExternalCall(service, endpoint, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    trackExternalCall({
      service,
      endpoint,
      success: true,
      latencyMs: Date.now() - start,
    });
    return result;
  } catch (err) {
    trackExternalCall({
      service,
      endpoint,
      success: false,
      latencyMs: Date.now() - start,
      errorCode: err?.code || err?.name || null,
      errorMessage: err?.message || null,
    });
    throw err;
  }
}

/**
 * Aggregate external API usage over a window. Returns per-service counts, success rate,
 * avg latency, top error codes. Used by the operator dashboard to answer "should we
 * drop BrightData?" with data instead of opinions.
 */
async function getExternalApiStats({ service = null, windowMs = 24 * 60 * 60 * 1000 } = {}) {
  const since = new Date(Date.now() - windowMs);
  let query = firestore.collection(TRACKER_COLLECTION).where('timestamp', '>=', since);
  if (service) {
    query = query.where('service', '==', service);
  }
  const snap = await query.get();
  const docs = snap.docs.map((d) => d.data());

  const byService = {};
  for (const m of docs) {
    const key = m.service || 'unknown';
    if (!byService[key]) {
      byService[key] = {
        total: 0,
        success: 0,
        failure: 0,
        latencySum: 0,
        latencyMax: 0,
        topErrors: {},
        topEndpoints: {},
      };
    }
    const bucket = byService[key];
    bucket.total += 1;
    if (m.success) bucket.success += 1;
    else bucket.failure += 1;
    bucket.latencySum += Number(m.latencyMs) || 0;
    if ((Number(m.latencyMs) || 0) > bucket.latencyMax) bucket.latencyMax = Number(m.latencyMs);
    if (!m.success && m.errorCode) {
      bucket.topErrors[m.errorCode] = (bucket.topErrors[m.errorCode] || 0) + 1;
    }
    if (m.endpoint) {
      bucket.topEndpoints[m.endpoint] = (bucket.topEndpoints[m.endpoint] || 0) + 1;
    }
  }

  // Finalize per-service stats
  for (const key of Object.keys(byService)) {
    const b = byService[key];
    b.successRate = b.total > 0 ? b.success / b.total : null;
    b.avgLatencyMs = b.total > 0 ? Math.round(b.latencySum / b.total) : 0;
    delete b.latencySum;
  }

  return {
    windowMs,
    sinceIso: since.toISOString(),
    totalRecords: docs.length,
    byService,
  };
}

module.exports = {
  trackExternalCall,
  instrumentExternalCall,
  getExternalApiStats,
  TRACKER_COLLECTION,
};
