'use strict';

/**
 * Shared best-effort operational alerting.
 *
 * Posts to Slack (SLACK_ALERTS_URL) AND writes an audit row to the `ops_alerts`
 * Firestore collection. Both are best-effort: alerting must NEVER throw into or
 * break the caller's path.
 *
 * Use for failures that would otherwise be silent (console.warn only) and which
 * a human needs to know about — oversell precursors (reserve/stock-sync
 * failures at order intake), dead crons, unhandled rejections.
 *
 * Intentionally simple and dependency-light so it is safe to call from the
 * hottest paths and from process-level handlers.
 */

function _slackPost(text) {
  const slackUrl = process.env.SLACK_ALERTS_URL;
  const fetchFn = global.fetch;
  if (!slackUrl || typeof fetchFn !== 'function') return;
  // Fire-and-forget; never await, never reject into the caller.
  Promise.resolve()
    .then(() => fetchFn(slackUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }))
    .catch((err) => console.warn(`[ops-alert] slack post failed: ${err && err.message}`));
}

/**
 * Emit an operational alert.
 *
 * @param {object} opts
 * @param {string} opts.source     - short tag, e.g. 'order-intake-kaufland'
 * @param {string} opts.message    - human-readable summary
 * @param {('warning'|'error'|'critical')} [opts.severity='error']
 * @param {string} [opts.tenantId='default']
 * @param {object} [opts.context]  - extra structured fields for the audit row
 * @returns {Promise<string>} the formatted alert text (also useful for tests/logs)
 */
async function sendOpsAlert({ source, message, severity = 'error', tenantId = 'default', context = {} } = {}) {
  const icon = severity === 'critical' ? '🚨' : severity === 'warning' ? '⚠️' : '❗';
  const text = `${icon} [${source || 'unknown'}] ${String(severity).toUpperCase()} — tenant=${tenantId || 'default'}\n${message || ''}`;

  try {
    _slackPost(text);
  } catch (err) {
    console.warn(`[ops-alert] slack dispatch error: ${err && err.message}`);
  }

  // Queryable audit trail for the ops dashboard. Best-effort.
  try {
    const { firestore } = require('./firestore');
    await firestore.collection('ops_alerts').add({
      source: source || 'unknown',
      severity,
      tenantId: tenantId || 'default',
      message: String(message || '').slice(0, 2000),
      context: context || {},
      text,
      createdAt: new Date().toISOString(),
    });
  } catch (writeErr) {
    console.warn(`[ops-alert] audit write failed: ${writeErr && writeErr.message}`);
  }

  return text;
}

module.exports = { sendOpsAlert };
