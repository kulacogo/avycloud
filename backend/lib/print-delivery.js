'use strict';
const { createHash } = require('node:crypto');
const { computeRetryDelayMs, shouldRetry } = require('./print-queue');

function printJobKey(tenantId, shipmentId, reprintId = '') {
  return createHash('sha256').update(JSON.stringify([tenantId, shipmentId, reprintId])).digest('hex');
}
function deliveryUpdate(job, actor, result) {
  if (job.tenantId !== actor.tenantId || job.claimedByUid !== actor.uid
    || job.claimedBy !== actor.agentId || !actor.claimToken || job.claimToken !== actor.claimToken) {
    const error = new Error('Druckauftrag wurde einer anderen Druckstation zugewiesen.');
    error.status = 409;
    throw error;
  }
  const now = new Date().toISOString();
  if (result.action === 'begin') {
    if (!['claimed', 'dispatching'].includes(job.status)) throw new Error('Druckauftrag ist nicht bereit.');
    return { status: 'dispatching', dispatchStartedAt: job.dispatchStartedAt || now };
  }
  if (job.status === 'done' && result.ok === true && result.spoolId === job.spoolId) return {};
  if (!['claimed', 'dispatching'].includes(job.status)) throw new Error('Druckauftrag ist bereits abgeschlossen.');
  if (result.ok === true) {
    if (job.status !== 'dispatching' || !result.spoolId) throw new Error('Druckerquittung fehlt.');
    return { status: 'done', finishedAt: now, error: null, spoolId: String(result.spoolId).slice(0, 300) };
  }
  const error = String(result.error || 'Druck fehlgeschlagen').slice(0, 500);
  if (job.status === 'dispatching') return { status: 'uncertain', finishedAt: now, error };
  if (shouldRetry(job)) return { status: 'queued', claimedAt: null, claimedBy: null, claimToken: null,
    error, notBefore: new Date(Date.now() + computeRetryDelayMs(job.attempts)).toISOString() };
  return { status: 'failed', finishedAt: now, error };
}
module.exports = { printJobKey, deliveryUpdate };
