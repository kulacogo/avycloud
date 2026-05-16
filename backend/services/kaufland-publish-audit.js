'use strict';

/**
 * Kaufland-Publish-Audit — persistiert Bulk-Publish-Runs in Firestore
 * (`kaufland_publish_runs`). Macht "55 Artikel gelistet"-Anzeigen
 * nachvollziehbar: für jede Bulk-Operation entsteht ein Dokument mit
 *
 *   {
 *     tenantId, storefront, source, requestedCount, requestedProductIds[],
 *     startedAt, status: 'running'|'completed',
 *     results: [{ productId, sku, ok, status, reason, fixes, idUnit,
 *                 durationMs, repaired, at }],
 *     summary: { total, success, failed, fixed, pending, skipped, repaired },
 *     completedAt, durationMs
 *   }
 *
 * Konsumiert von der Bulk-Publish-Route, lesbar via Admin-UI / Reports.
 *
 * Firestore `arrayUnion` hat ein 1 MiB Doc-Limit. Solange < 500 Results
 * passt das problemlos in ein einzelnes Dokument; darüber loggen wir eine
 * WARNING und stoppen das weitere arrayUnion-Append (eine künftige
 * Erweiterung könnte auf eine `items` Subcollection umschalten).
 *
 * Multi-Tenant: tenantId ist Pflicht und wird in jedem Dokument persistiert.
 * Keine direkten Schreibpfade auf `products_v2` — additive Logging-Schicht.
 */

const { firestore } = require('../lib/firestore');
const { FieldValue, Timestamp } = require('@google-cloud/firestore');

const COLLECTION_NAME = 'kaufland_publish_runs';
const MAX_REQUESTED_IDS = 500;
const MAX_RESULTS_IN_ARRAY = 500;

function safeString(v) {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function nowIso() {
  return new Date().toISOString();
}

function toArrayOfStrings(input, max) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const v of input) {
    const s = safeString(v);
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Start a new run. Creates a new Firestore doc with status='running'.
 *
 * @param {object} opts
 * @param {string} opts.tenantId       — REQUIRED. tenant scoping.
 * @param {string} opts.storefront     — e.g. 'de'.
 * @param {string} [opts.source='ui-bulk'] — caller, e.g. 'ui-bulk', 'cron'.
 * @param {string[]} opts.requestedProductIds — full request list (will be
 *                                              capped at 500 in the doc to
 *                                              stay safely below 1 MiB).
 * @returns {Promise<string>}          — the new docId.
 */
async function startRun({ tenantId, storefront, source = 'ui-bulk', requestedProductIds = [] } = {}) {
  const tid = safeString(tenantId);
  if (!tid) {
    const err = new Error('startRun requires tenantId');
    err.code = 'KAUFLAND_PUBLISH_AUDIT_TENANT_REQUIRED';
    throw err;
  }
  const sf = safeString(storefront);
  const src = safeString(source) || 'ui-bulk';
  const allIds = Array.isArray(requestedProductIds) ? requestedProductIds : [];
  const requestedCount = allIds.length;
  const idsForDoc = toArrayOfStrings(allIds, MAX_REQUESTED_IDS);

  const docRef = firestore.collection(COLLECTION_NAME).doc();
  const now = Timestamp.now();
  await docRef.set({
    tenantId: tid,
    storefront: sf,
    source: src,
    requestedCount,
    requestedProductIds: idsForDoc,
    requestedProductIdsTruncated: requestedCount > MAX_REQUESTED_IDS,
    startedAt: now,
    startedAtIso: nowIso(),
    status: 'running',
    results: [],
  });
  return docRef.id;
}

/**
 * Append a per-product result onto the run via arrayUnion.
 *
 * @param {object} opts
 * @param {string} opts.runId          — REQUIRED. doc id returned by startRun().
 * @param {string} opts.productId
 * @param {string} [opts.sku]
 * @param {boolean} [opts.ok=false]
 * @param {string} [opts.status]       — caller-defined status code (created/updated/skipped/failed/...).
 * @param {string} [opts.reason]
 * @param {string[]} [opts.fixes=[]]
 * @param {number|string|null} [opts.idUnit=null]
 * @param {number} [opts.durationMs=0]
 * @param {boolean} [opts.repaired=false]
 */
async function appendResult({
  runId,
  productId,
  sku,
  ok = false,
  status,
  reason,
  fixes = [],
  idUnit = null,
  durationMs = 0,
  repaired = false,
} = {}) {
  const id = safeString(runId);
  if (!id) {
    const err = new Error('appendResult requires runId');
    err.code = 'KAUFLAND_PUBLISH_AUDIT_RUN_ID_REQUIRED';
    throw err;
  }
  const docRef = firestore.collection(COLLECTION_NAME).doc(id);
  const snap = await docRef.get();
  if (!snap.exists) {
    const err = new Error(`appendResult: run ${id} not found`);
    err.code = 'KAUFLAND_PUBLISH_AUDIT_RUN_NOT_FOUND';
    throw err;
  }

  const existing = snap.data() || {};
  const existingResults = Array.isArray(existing.results) ? existing.results : [];
  if (existingResults.length >= MAX_RESULTS_IN_ARRAY) {
    console.warn(
      `[kaufland-publish-audit] Run ${id} already has ${existingResults.length} results; ` +
      'further appendResult calls are no-ops. Consider migrating to a subcollection.'
    );
    return;
  }

  const entry = {
    productId: safeString(productId),
    sku: safeString(sku),
    ok: !!ok,
    status: safeString(status),
    reason: safeString(reason),
    fixes: Array.isArray(fixes) ? fixes.map((f) => safeString(f)).filter(Boolean) : [],
    idUnit: idUnit == null ? null : String(idUnit),
    durationMs: Number.isFinite(Number(durationMs)) ? Number(durationMs) : 0,
    repaired: !!repaired,
    at: Timestamp.now(),
  };

  await docRef.update({
    results: FieldValue.arrayUnion(entry),
  });
}

/**
 * Finalize a run with a summary block.
 *
 * @param {object} opts
 * @param {string} opts.runId
 * @param {object} opts.summary  — { total, success, failed, fixed, pending, skipped, repaired }
 */
async function finalizeRun({ runId, summary } = {}) {
  const id = safeString(runId);
  if (!id) {
    const err = new Error('finalizeRun requires runId');
    err.code = 'KAUFLAND_PUBLISH_AUDIT_RUN_ID_REQUIRED';
    throw err;
  }
  const docRef = firestore.collection(COLLECTION_NAME).doc(id);
  const snap = await docRef.get();
  if (!snap.exists) {
    const err = new Error(`finalizeRun: run ${id} not found`);
    err.code = 'KAUFLAND_PUBLISH_AUDIT_RUN_NOT_FOUND';
    throw err;
  }

  const data = snap.data() || {};
  const startedAtMs = (() => {
    if (data.startedAt && typeof data.startedAt.toMillis === 'function') return data.startedAt.toMillis();
    if (data.startedAtIso) {
      const ms = Date.parse(data.startedAtIso);
      return Number.isFinite(ms) ? ms : Date.now();
    }
    return Date.now();
  })();

  const nowTs = Timestamp.now();
  const completedMs = typeof nowTs.toMillis === 'function' ? nowTs.toMillis() : Date.now();
  const durationMs = Math.max(0, completedMs - startedAtMs);

  const safeSummary = (() => {
    const s = summary && typeof summary === 'object' ? summary : {};
    const numFields = ['total', 'success', 'failed', 'fixed', 'pending', 'skipped', 'repaired'];
    const out = {};
    for (const k of numFields) {
      const n = Number(s[k]);
      out[k] = Number.isFinite(n) ? n : 0;
    }
    return out;
  })();

  await docRef.update({
    status: 'completed',
    completedAt: nowTs,
    completedAtIso: nowIso(),
    summary: safeSummary,
    durationMs,
  });
}

module.exports = {
  startRun,
  appendResult,
  finalizeRun,
  // exposed for tests/migration
  COLLECTION_NAME,
  MAX_REQUESTED_IDS,
  MAX_RESULTS_IN_ARRAY,
};
