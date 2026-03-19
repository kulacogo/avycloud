'use strict';

/**
 * error-dashboard.js — Query, aggregate, and resolve operational errors.
 */

const { firestore } = require('../lib/firestore');
const { FieldValue } = require('@google-cloud/firestore');
const { COLLECTION } = require('../lib/error-collector');

/**
 * List errors with optional filters and pagination.
 *
 * @param {{
 *   tenantId?: string,
 *   type?: string,
 *   channel?: string,
 *   severity?: string,
 *   status?: string,
 *   page?: number,
 *   pageSize?: number,
 * }} opts
 * @returns {Promise<{ errors: object[], total: number, page: number, pageSize: number }>}
 */
async function listErrors(opts = {}) {
  const {
    tenantId = 'default',
    type,
    channel,
    severity,
    status,
    page = 1,
    pageSize = 50,
  } = opts;

  const clamped = Math.max(1, Math.min(pageSize, 100));
  const currentPage = Math.max(1, page);

  let query = firestore.collection(COLLECTION).where('tenantId', '==', tenantId);

  if (type) query = query.where('type', '==', type);
  if (channel) query = query.where('channel', '==', channel);
  if (severity) query = query.where('severity', '==', severity);
  if (status) query = query.where('status', '==', status);

  query = query.orderBy('createdAt', 'desc');

  // Get total count with same filters (capped at 500 for performance)
  const countSnap = await query.limit(500).get();
  const total = countSnap.size;

  // Paginate
  const offset = (currentPage - 1) * clamped;
  const snap = await query.offset(offset).limit(clamped).get();

  const errors = snap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      ...data,
      createdAt: data.createdAt?.toDate?.() ? data.createdAt.toDate().toISOString() : data.createdAt || null,
      resolvedAt: data.resolvedAt?.toDate?.() ? data.resolvedAt.toDate().toISOString() : data.resolvedAt || null,
    };
  });

  return { errors, total, page: currentPage, pageSize: clamped };
}

/**
 * Aggregate error counts by status, severity, type, and channel.
 *
 * Queries all open errors + resolved errors from the last 24 hours.
 *
 * @param {{ tenantId?: string }} opts
 * @returns {Promise<{ total: number, byStatus: object, bySeverity: object, byType: object, byChannel: object }>}
 */
async function getErrorSummary(opts = {}) {
  const { tenantId = 'default' } = opts;

  // Fetch all open errors
  const openSnap = await firestore
    .collection(COLLECTION)
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'open')
    .limit(1000)
    .get();

  // Fetch recently resolved (last 24h)
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const resolvedSnap = await firestore
    .collection(COLLECTION)
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'resolved')
    .where('resolvedAt', '>=', cutoff)
    .limit(500)
    .get();

  const allDocs = [...openSnap.docs, ...resolvedSnap.docs];

  const byStatus = { open: 0, resolved: 0 };
  const bySeverity = { critical: 0, warning: 0, info: 0 };
  const byType = {};
  const byChannel = {};

  for (const doc of allDocs) {
    const data = doc.data();
    // Status
    if (data.status === 'open') byStatus.open++;
    else byStatus.resolved++;

    // Only count open errors for severity/type/channel KPIs
    if (data.status === 'open') {
      if (data.severity && bySeverity[data.severity] !== undefined) {
        bySeverity[data.severity]++;
      }
      if (data.type) {
        byType[data.type] = (byType[data.type] || 0) + 1;
      }
      if (data.channel) {
        byChannel[data.channel] = (byChannel[data.channel] || 0) + 1;
      }
    }
  }

  return {
    total: byStatus.open,
    byStatus,
    bySeverity,
    byType,
    byChannel,
  };
}

/**
 * Mark an error as resolved.
 *
 * @param {{ tenantId?: string, errorId: string, resolvedBy?: string }} opts
 * @returns {Promise<{ ok: boolean }>}
 */
async function resolveError(opts = {}) {
  const { tenantId = 'default', errorId, resolvedBy = 'unknown' } = opts;

  if (!errorId) throw Object.assign(new Error('errorId required'), { statusCode: 400, code: 'BAD_REQUEST' });

  const docRef = firestore.collection(COLLECTION).doc(errorId);
  const snap = await docRef.get();

  if (!snap.exists) {
    throw Object.assign(new Error('Error not found'), { statusCode: 404, code: 'NOT_FOUND' });
  }

  const data = snap.data();
  if (data.tenantId !== tenantId) {
    throw Object.assign(new Error('Error not found'), { statusCode: 404, code: 'NOT_FOUND' });
  }

  await docRef.update({
    status: 'resolved',
    resolvedAt: FieldValue.serverTimestamp(),
    resolvedBy,
  });

  return { ok: true };
}

module.exports = { listErrors, getErrorSummary, resolveError };
