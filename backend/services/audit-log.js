/**
 * Audit-Log Service
 *
 * Logs significant user and system actions to Firestore for traceability.
 * Collection: audit_log
 *
 * Usage:
 *   const { logAudit } = require('./audit-log');
 *   await logAudit({ action: 'product.created', userId, details: { productId } });
 */

const { firestore } = require('../lib/firestore');

const AUDIT_COLLECTION = 'audit_log';

/**
 * Write an audit log entry.
 *
 * @param {Object} entry
 * @param {string} entry.action - e.g. 'product.created', 'product.merged', 'order.status_changed'
 * @param {string} [entry.userId] - Firebase Auth UID of the acting user
 * @param {string} [entry.userEmail] - Email for display
 * @param {string} [entry.tenantId] - Tenant ID (default: 'default')
 * @param {string} [entry.resourceType] - 'product', 'order', 'listing', 'user', etc.
 * @param {string} [entry.resourceId] - ID of the affected resource
 * @param {Object} [entry.details] - Additional context (old/new values, counts, etc.)
 * @param {string} [entry.ip] - Request IP address
 */
async function logAudit({
  action,
  userId = null,
  userEmail = null,
  tenantId = 'default',
  resourceType = null,
  resourceId = null,
  details = null,
  ip = null,
}) {
  try {
    const doc = {
      action,
      userId,
      userEmail,
      tenantId,
      resourceType,
      resourceId,
      details,
      ip,
      timestamp: new Date().toISOString(),
    };
    await firestore.collection(AUDIT_COLLECTION).add(doc);
  } catch (err) {
    // Audit logging should never break the main flow
    console.error(`[audit-log] Failed to write: ${err.message}`);
  }
}

/**
 * Query audit log entries with filters.
 *
 * @param {Object} params
 * @param {string} [params.tenantId]
 * @param {string} [params.action] - Filter by action prefix (e.g. 'product')
 * @param {string} [params.resourceType] - Filter by resource type
 * @param {string} [params.resourceId] - Filter by specific resource
 * @param {string} [params.userId] - Filter by user
 * @param {number} [params.limit] - Max results (default 100)
 * @param {string} [params.startAfter] - Cursor for pagination (ISO timestamp)
 * @returns {Array} audit log entries
 */
async function queryAuditLog({
  tenantId = 'default',
  action = null,
  resourceType = null,
  resourceId = null,
  userId = null,
  limit = 100,
  startAfter = null,
} = {}) {
  // Simple single-field query + orderBy to avoid composite index requirements.
  // Firestore allows equality filters on one field + orderBy on another without
  // a composite index, but range filters (>=, <=) on a different field than
  // orderBy require one. We filter by tenantId (equality) + order by timestamp,
  // then apply action prefix matching client-side.
  let query = firestore
    .collection(AUDIT_COLLECTION)
    .where('tenantId', '==', tenantId)
    .orderBy('timestamp', 'desc')
    .limit(Math.min(limit, 500));

  if (startAfter) {
    query = query.startAfter(startAfter);
  }

  const snap = await query.get();
  let results = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  // Client-side filtering (avoids composite index requirement)
  if (action) {
    results = results.filter((e) => (e.action || '').startsWith(action));
  }
  if (resourceType) {
    results = results.filter((e) => e.resourceType === resourceType);
  }
  if (resourceId) {
    results = results.filter((e) => e.resourceId === resourceId);
  }
  if (userId) {
    results = results.filter((e) => e.userId === userId);
  }

  return results;
}

/**
 * Compute a human-readable diff of product fields.
 * Returns an array of { field, from, to } for changed top-level and nested fields.
 * Only tracks meaningful business fields, not internal metadata.
 */
function diffProduct(before, after) {
  const changes = [];
  if (!before || !after) return changes;

  const flat = (obj, prefix = '') => {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        Object.assign(out, flat(v, key));
      } else {
        out[key] = v;
      }
    }
    return out;
  };

  // Only diff these top-level sections to avoid noise from ops/internal fields
  const sections = [
    'identification.name', 'identification.brand', 'identification.sku',
    'identification.barcodes',
    'details.title', 'details.short_description', 'details.description',
    'details.categoryId', 'details.category_breadcrumb',
    'details.condition', 'details.handling_time',
    'details.pricing.sellPrice', 'details.pricing.lowest_price.amount',
    'details.weight', 'details.attributes',
    'details.key_features', 'details.images',
    'details.identifiers.ean', 'details.identifiers.gtin',
    'details.identifiers.mpn', 'details.identifiers.upc',
    'details.gpsr',
  ];

  const get = (obj, path) => {
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return undefined;
      cur = cur[p];
    }
    return cur;
  };

  const serialize = (v) => {
    if (v === undefined || v === null) return null;
    if (Array.isArray(v)) return JSON.stringify(v);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };

  for (const path of sections) {
    const oldVal = serialize(get(before, path));
    const newVal = serialize(get(after, path));
    if (oldVal !== newVal) {
      changes.push({ field: path, from: oldVal, to: newVal });
    }
  }

  return changes;
}

module.exports = {
  logAudit,
  queryAuditLog,
  diffProduct,
  AUDIT_COLLECTION,
};
