'use strict';

/**
 * identify-runs-dashboard.js — Query and normalize identify-pipeline runs
 * across V3 and V4 for the Admin-Audit-Endpoint (Plan D.1).
 *
 * Reads from `products_v2` filtered by `tenantId` + optional date-range over
 * the top-level mirror fields `identifyCheckedAtIso` (V4) and
 * `identifyV3CheckedAtIso` (V3) — see Plan D.4 for the rationale of these
 * mirror fields.
 *
 * Mapper-Layer normalizes both `ops.data_quality.identify_v3` and
 * `ops.data_quality.identify_v4` onto a shared representation so the UI can
 * render runs uniformly regardless of pipeline. Cassini sub-scores are
 * surfaced when `lib/cassini-scorer` is reachable (defensive, never throws).
 *
 * Pure read-path — never mutates Firestore. Defensive against missing
 * fields: degraded products still surface, with `null` for unknown values.
 */

const { firestore } = require('../lib/firestore');

const PRODUCTS_COLLECTION =
  String(process.env.USE_PRODUCTS_V2 || 'true').toLowerCase() !== 'false'
    ? 'products_v2'
    : 'products';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;
const COUNT_HARD_CAP = 1000;

function clampPage(page) {
  const n = Number(page);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function clampPageSize(pageSize) {
  const n = Number(pageSize);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.floor(n));
}

function safeNumber(v) {
  if (v == null) return null;
  const n = typeof v === 'string' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function isoOrNull(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (v && typeof v.toDate === 'function') {
    try {
      return v.toDate().toISOString();
    } catch (_) {
      return null;
    }
  }
  return null;
}

/**
 * Mapper — normalizes a single product's identify-V3 or identify-V4 metadata
 * onto a shared shape.
 *
 * Output keys (always present):
 *   - pipeline:        'v3' | 'v4' | null
 *   - productId:       string | null
 *   - sku:             string | null
 *   - checkedAtIso:    ISO string | null
 *   - confidence:      { aggregate: number|null, readyForPublish: bool|null, missingCritical: string[] }
 *   - workerSummary:   { domain: { confidence: number|null, ok: bool|null, retriesRequested: number|null, ... } }
 *   - criticScore:     number | null  (ebay_ready_score from V4, marketplace_readiness from V3)
 *   - cassiniSubscores: { title, description, image, specifics, compliance, overall } | null
 *   - issues:          Array<{ rule, severity, message }>
 *   - conflicts:       Array<...>
 */
function mapProductToRun(product) {
  const ops = (product && product.ops && typeof product.ops === 'object') ? product.ops : {};
  const dq = (ops.data_quality && typeof ops.data_quality === 'object') ? ops.data_quality : {};
  const v4 = (dq.identify_v4 && typeof dq.identify_v4 === 'object') ? dq.identify_v4 : null;
  const v3 = (dq.identify_v3 && typeof dq.identify_v3 === 'object') ? dq.identify_v3 : null;

  // Prefer V4 when both exist (newer pipeline).
  const pipeline = v4 ? 'v4' : v3 ? 'v3' : null;
  const productId = product?.id ? String(product.id) : null;
  const sku = product?.identification?.sku ? String(product.identification.sku) : null;

  let checkedAtIso = null;
  let confidence = { aggregate: null, readyForPublish: null, missingCritical: [] };
  let workerSummary = {};
  let criticScore = null;
  let issues = [];
  let conflicts = [];

  if (pipeline === 'v4' && v4) {
    checkedAtIso = isoOrNull(v4.checked_at_iso) || isoOrNull(product.identifyCheckedAtIso);
    const conf = (v4.confidence && typeof v4.confidence === 'object') ? v4.confidence : {};
    confidence = {
      aggregate: safeNumber(conf.aggregate),
      readyForPublish: typeof conf.readyForPublish === 'boolean' ? conf.readyForPublish : null,
      missingCritical: Array.isArray(conf.missingCritical) ? conf.missingCritical.slice(0, 32) : [],
    };
    // Worker-summary: map ops.data_quality.identify_v4.worker_meta + confidence.fields.
    const fields = (conf.fields && typeof conf.fields === 'object') ? conf.fields : {};
    const workerMeta = (v4.worker_meta && typeof v4.worker_meta === 'object') ? v4.worker_meta : {};
    const allDomains = new Set([...Object.keys(workerMeta), ...Object.keys(fields)]);
    for (const domain of allDomains) {
      const meta = workerMeta[domain] || {};
      const fld = fields[domain] || {};
      workerSummary[domain] = {
        confidence: safeNumber(fld.score),
        ok: typeof meta.ok === 'boolean' ? meta.ok : null,
        retriesRequested: safeNumber(meta.retriesRequested),
        sources: Array.isArray(meta.sources) ? meta.sources.slice(0, 8) : [],
      };
    }
    if (v4.critic && typeof v4.critic === 'object') {
      criticScore = safeNumber(v4.critic.ebay_ready_score);
      if (Array.isArray(v4.critic.issues)) issues = v4.critic.issues.slice(0, 32);
    }
    if (Array.isArray(v4.conflicts)) conflicts = v4.conflicts.slice(0, 32);
  } else if (pipeline === 'v3' && v3) {
    checkedAtIso = isoOrNull(v3.checked_at_iso) || isoOrNull(product.identifyV3CheckedAtIso);
    confidence = {
      aggregate: safeNumber(v3.overall_score),
      readyForPublish: null,
      missingCritical: [],
    };
    // V3 stores per-field confidence under field_confidence
    const fc = (v3.field_confidence && typeof v3.field_confidence === 'object') ? v3.field_confidence : {};
    for (const [domain, val] of Object.entries(fc)) {
      const score = typeof val === 'number' ? val : safeNumber(val && val.score);
      workerSummary[domain] = {
        confidence: score,
        ok: null,
        retriesRequested: null,
        sources: [],
      };
    }
    // marketplace_readiness in V3 ≈ critic readiness in V4
    if (v3.marketplace_readiness && typeof v3.marketplace_readiness === 'object') {
      criticScore = safeNumber(
        v3.marketplace_readiness.ebay ||
          v3.marketplace_readiness.overall ||
          v3.marketplace_readiness.score
      );
    }
    const xr = v3.cross_reference && typeof v3.cross_reference === 'object' ? v3.cross_reference : null;
    if (xr && Array.isArray(xr.conflicts)) conflicts = xr.conflicts.slice(0, 32);
  }

  // Optional Cassini sub-scores — defensive: never let scorer crash the mapper.
  let cassiniSubscores = null;
  try {
    const { scoreProductCassini } = require('../lib/cassini-scorer');
    if (typeof scoreProductCassini === 'function') {
      const c = scoreProductCassini(product) || null;
      if (c && typeof c === 'object') {
        cassiniSubscores = {
          overall: safeNumber(c.overall),
          title: safeNumber(c.title_score),
          description: safeNumber(c.description_score),
          image: safeNumber(c.image_score),
          specifics: safeNumber(c.specifics_score),
          compliance: safeNumber(c.compliance_score),
        };
      }
    }
  } catch (err) {
    // Pure best-effort — Cassini being unavailable must not break audit.
    cassiniSubscores = null;
  }

  return {
    pipeline,
    productId,
    sku,
    checkedAtIso,
    confidence,
    workerSummary,
    criticScore,
    cassiniSubscores,
    issues,
    conflicts,
  };
}

/**
 * listIdentifyRuns(opts) — paginated list of identify pipeline runs.
 *
 * @param {Object} opts
 * @param {string} opts.tenantId           MANDATORY tenant filter
 * @param {number} [opts.confidence_min]   0..1 confidence aggregate lower bound
 * @param {number} [opts.confidence_max]   0..1 confidence aggregate upper bound
 * @param {string} [opts.domain]           Only runs whose workerSummary contains this domain
 * @param {string} [opts.dateFrom]         ISO string — inclusive lower bound for checkedAtIso
 * @param {string} [opts.dateTo]           ISO string — inclusive upper bound for checkedAtIso
 * @param {string} [opts.pipeline]         'v3' | 'v4' | 'all' (default 'all')
 * @param {number} [opts.page]             1-based page (default 1)
 * @param {number} [opts.pageSize]         capped at 100 (default 50)
 * @returns {Promise<{ runs: Array, total: number, page: number, pageSize: number }>}
 */
async function listIdentifyRuns(opts = {}) {
  const tenantId = opts && typeof opts.tenantId === 'string' ? opts.tenantId.trim() : '';
  if (!tenantId) {
    const err = new Error('tenantId required');
    err.statusCode = 400;
    err.code = 'BAD_REQUEST';
    throw err;
  }

  const pipeline = ['v3', 'v4', 'all'].includes(opts.pipeline) ? opts.pipeline : 'all';
  const confMin = Number.isFinite(Number(opts.confidence_min)) ? Number(opts.confidence_min) : null;
  const confMax = Number.isFinite(Number(opts.confidence_max)) ? Number(opts.confidence_max) : null;
  const domain = opts.domain && typeof opts.domain === 'string' ? opts.domain.trim() : '';
  const dateFrom = opts.dateFrom && typeof opts.dateFrom === 'string' ? opts.dateFrom.trim() : '';
  const dateTo = opts.dateTo && typeof opts.dateTo === 'string' ? opts.dateTo.trim() : '';
  const page = clampPage(opts.page);
  const pageSize = clampPageSize(opts.pageSize);

  // Firestore query — server-side filter by tenantId. Date-range needs a
  // composite index (already provisioned: tenantId + identifyCheckedAtIso,
  // tenantId + identifyV3CheckedAtIso). We pull a HARD_CAP-bounded set and
  // perform in-memory filtering for the remaining facets (confidence_min/max,
  // domain, pipeline) to avoid query-fan-out and stay safe under index-budget.
  let query = firestore.collection(PRODUCTS_COLLECTION).where('tenantId', '==', tenantId);

  // Apply date range against whichever mirror field corresponds to the
  // requested pipeline. For pipeline='all' we use V4's field (most products
  // will be V4 by the time D.1 lands) and re-filter in-memory for V3 candidates.
  const dateField = pipeline === 'v3' ? 'identifyV3CheckedAtIso' : 'identifyCheckedAtIso';
  if (dateFrom) query = query.where(dateField, '>=', dateFrom);
  if (dateTo) query = query.where(dateField, '<=', dateTo);

  let snap;
  try {
    snap = await query.limit(COUNT_HARD_CAP).get();
  } catch (err) {
    // Index-error or other firestore failure — propagate as 500.
    const wrapped = new Error(`Failed to query identify-runs: ${err && err.message}`);
    wrapped.cause = err;
    throw wrapped;
  }

  const docs = [];
  if (snap && typeof snap.forEach === 'function') {
    snap.forEach((doc) => {
      const data = (doc && typeof doc.data === 'function') ? doc.data() : doc;
      if (data) docs.push({ ...data, id: data?.id || (doc && doc.id) || null });
    });
  }

  // Map → filter → paginate.
  const mapped = docs.map(mapProductToRun);

  const filtered = mapped.filter((run) => {
    if (!run.pipeline) return false;
    if (pipeline !== 'all' && run.pipeline !== pipeline) return false;
    if (confMin != null && (run.confidence.aggregate == null || run.confidence.aggregate < confMin)) {
      return false;
    }
    if (confMax != null && (run.confidence.aggregate == null || run.confidence.aggregate > confMax)) {
      return false;
    }
    if (domain && !Object.prototype.hasOwnProperty.call(run.workerSummary, domain)) {
      return false;
    }
    return true;
  });

  // Sort newest-first by checkedAtIso (defensive against null).
  filtered.sort((a, b) => {
    const ta = a.checkedAtIso ? Date.parse(a.checkedAtIso) : 0;
    const tb = b.checkedAtIso ? Date.parse(b.checkedAtIso) : 0;
    return tb - ta;
  });

  const total = filtered.length;
  const offset = (page - 1) * pageSize;
  const runs = filtered.slice(offset, offset + pageSize);

  return { runs, total, page, pageSize };
}

module.exports = {
  listIdentifyRuns,
  // Exposed for tests + the LLM-parity service to share the mapper.
  _internal: { mapProductToRun, PRODUCTS_COLLECTION },
};
