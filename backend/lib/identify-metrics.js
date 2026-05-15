'use strict';

const { firestore } = require('./firestore');
const logger = require('./logger');

const METRICS_COLLECTION = 'identify_metrics';
const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * Fire-and-forget metric writer. NEVER throws and never blocks the calling request —
 * Firestore latency or downtime must not surface as a slow identify response.
 *
 * Status semantics:
 *   success           — full pipeline produced a saved product
 *   duplicate_reused  — existing product matched (V3 / grounding / legacy duplicate check)
 *   timeout           — wall-clock budget exhausted, 504 returned
 *   error             — pipeline failed with any other error (500 returned)
 */
async function recordIdentifyMetric({
  tenantId = 'default',
  pipeline,
  durationMs,
  status,
  errorCode = null,
  errorMessage = null,
  imageCount = 0,
  barcodeCount = 0,
  productId = null,
} = {}) {
  try {
    await firestore.collection(METRICS_COLLECTION).add({
      tenantId,
      timestamp: new Date(),
      pipeline: pipeline || 'unknown',
      durationMs: Number(durationMs) || 0,
      status: status || 'unknown',
      errorCode,
      errorMessage: errorMessage ? String(errorMessage).slice(0, MAX_ERROR_MESSAGE_LENGTH) : null,
      imageCount: Number(imageCount) || 0,
      barcodeCount: Number(barcodeCount) || 0,
      productId,
    });
  } catch (err) {
    logger.warn({ err: err?.message }, '[identify-metrics] failed to write metric');
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

/**
 * Aggregate identify metrics over a time window. Returns counts by status / pipeline /
 * error code, success rate, and p50/p95 of successful-request durations.
 *
 * If `tenantId` is null, aggregates across all tenants — used for the global health
 * dashboard. Tenant-scoped callers must pass their tenant explicitly.
 */
async function getIdentifyHealth({ tenantId = null, windowMs = 24 * 60 * 60 * 1000 } = {}) {
  const since = new Date(Date.now() - windowMs);
  let query = firestore.collection(METRICS_COLLECTION).where('timestamp', '>=', since);
  if (tenantId) {
    query = query.where('tenantId', '==', tenantId);
  }
  const snap = await query.get();
  const docs = snap.docs.map((d) => d.data());

  const byStatus = {};
  const byPipeline = {};
  const byError = {};
  const durations = [];
  let lastFailure = null;

  for (const m of docs) {
    byStatus[m.status] = (byStatus[m.status] || 0) + 1;
    byPipeline[m.pipeline] = (byPipeline[m.pipeline] || 0) + 1;
    if (m.errorCode) {
      byError[m.errorCode] = (byError[m.errorCode] || 0) + 1;
      const ts = m.timestamp?.toMillis?.() ?? new Date(m.timestamp || 0).getTime();
      const prevTs = lastFailure ? (lastFailure.timestamp?.toMillis?.() ?? new Date(lastFailure.timestamp || 0).getTime()) : 0;
      if (!lastFailure || ts > prevTs) {
        lastFailure = m;
      }
    }
    if (m.status === 'success' && m.durationMs > 0) {
      durations.push(m.durationMs);
    }
  }

  durations.sort((a, b) => a - b);
  const p50 = percentile(durations, 0.5);
  const p95 = percentile(durations, 0.95);
  const avg = durations.length
    ? Math.round(durations.reduce((s, x) => s + x, 0) / durations.length)
    : 0;

  const total = docs.length;
  const success = byStatus.success || 0;
  const successRate = total > 0 ? success / total : null;

  return {
    windowMs,
    sinceIso: since.toISOString(),
    total,
    success,
    successRate,
    byStatus,
    byPipeline,
    byError,
    durations: { count: durations.length, avgMs: avg, p50Ms: p50, p95Ms: p95 },
    lastFailure: lastFailure
      ? {
          timestampIso:
            lastFailure.timestamp?.toDate?.().toISOString() ||
            new Date(lastFailure.timestamp || 0).toISOString(),
          pipeline: lastFailure.pipeline,
          errorCode: lastFailure.errorCode,
          errorMessage: lastFailure.errorMessage,
        }
      : null,
  };
}

module.exports = {
  recordIdentifyMetric,
  getIdentifyHealth,
  METRICS_COLLECTION,
};
