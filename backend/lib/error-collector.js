'use strict';

/**
 * error-collector.js — Fire-and-forget error writer.
 *
 * Writes operational errors to the `operationalErrors` Firestore collection.
 * NEVER throws, NEVER blocks. Safe to call from any catch block.
 */

const { firestore } = require('./firestore');
const { FieldValue } = require('@google-cloud/firestore');

const COLLECTION = 'operationalErrors';

const VALID_TYPES = ['sync_failure', 'api_error', 'job_failure', 'validation_error', 'webhook_error'];
const VALID_SEVERITIES = ['critical', 'warning', 'info'];
const VALID_CHANNELS = ['ebay', 'kaufland', 'sendcloud', 'internal'];

/**
 * Pattern-match a fix suggestion from the error message.
 * @param {string} message
 * @returns {string|null}
 */
function matchFixSuggestion(message) {
  if (!message) return null;
  const lower = message.toLowerCase();

  if (lower.includes('timeout') || lower.includes('etimedout')) {
    return 'API temporär nicht erreichbar — wird erneut versucht';
  }
  if (lower.includes('ean') && (lower.includes('missing') || lower.includes('fehlt'))) {
    return 'EAN fehlt — Produkt bearbeiten und EAN ergänzen';
  }
  if (lower.includes('max retries') || lower.includes('exhausted')) {
    return 'Job fehlgeschlagen — Bild/Daten prüfen, erneut versuchen';
  }
  if (lower.includes('signature') || lower.includes('hmac')) {
    return 'Webhook-Secret in Einstellungen prüfen';
  }
  if (lower.includes('tracking')) {
    return 'Tracking manuell im Marktplatz eintragen';
  }

  return null;
}

/**
 * Write an operational error to Firestore.
 *
 * Fire-and-forget: wraps ALL logic in try/catch, NEVER throws, NEVER blocks the caller.
 *
 * @param {{
 *   tenantId?: string,
 *   type: string,
 *   severity?: string,
 *   channel?: string,
 *   message: string,
 *   details?: string,
 *   entityType?: string,
 *   entityId?: string,
 *   entityName?: string,
 *   source: string,
 * }} opts
 */
async function collectError(opts = {}) {
  try {
    const {
      tenantId = 'default',
      type = 'api_error',
      severity = 'warning',
      channel = 'internal',
      message = 'Unknown error',
      details = null,
      entityType = null,
      entityId = null,
      entityName = null,
      source = 'unknown',
    } = opts;

    const doc = {
      tenantId,
      type: VALID_TYPES.includes(type) ? type : 'api_error',
      severity: VALID_SEVERITIES.includes(severity) ? severity : 'warning',
      channel: VALID_CHANNELS.includes(channel) ? channel : 'internal',
      message: String(message).slice(0, 2000),
      details: details ? String(details).slice(0, 5000) : null,
      entityType: entityType || null,
      entityId: entityId || null,
      entityName: entityName || null,
      source: String(source).slice(0, 200),
      status: 'open',
      fixSuggestion: matchFixSuggestion(message),
      createdAt: FieldValue.serverTimestamp(),
    };

    // Fire-and-forget — do not await in calling code
    firestore.collection(COLLECTION).add(doc).catch((writeErr) => {
      console.error(`[error-collector] Failed to write error: ${writeErr.message}`);
    });
  } catch (outerErr) {
    // Absolute safety net — never throw from this function
    console.error(`[error-collector] Unexpected failure: ${outerErr.message}`);
  }
}

module.exports = { collectError, matchFixSuggestion, COLLECTION };
