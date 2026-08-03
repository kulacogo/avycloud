'use strict';

/**
 * Filter für die gzip-Antwort-Komprimierung (siehe index.js).
 *
 * Hintergrund: Die Produktliste geht unkomprimiert bis 32 MB über die
 * Leitung — Juli 2026 waren das 758 GiB Egress (69,74 €). JSON komprimiert
 * um ~90 %.
 *
 * NIEMALS komprimieren:
 *   - `text/event-stream` (SSE). `compression` puffert Antworten; ein
 *     gepufferter SSE-Stream heißt im Betrieb: keine Auftrags-Benachrichti-
 *     gungen, kein Chat-Streaming, kein Erfassen-Fortschritt mehr.
 *     Betroffen: routes/sse.js (/api/events), routes/identify.js (Chat +
 *     Identify-Progress), routes/products.js.
 *   - Antworten, deren Anfrage `x-no-compression` trägt (manueller Notausstieg
 *     ohne Redeploy).
 *
 * @param {Function|null} defaultFilter üblicherweise `compression.filter`
 *   (überspringt bereits komprimierte Typen wie JPEG/PDF anhand der mime-db)
 * @returns {Function} Filter mit der von `compression` erwarteten Signatur
 */
function makeCompressionFilter(defaultFilter) {
  return function compressionFilter(req, res) {
    if (req && req.headers && req.headers['x-no-compression']) return false;

    const rawType =
      res && typeof res.getHeader === 'function' ? res.getHeader('Content-Type') : null;
    if (String(rawType || '').toLowerCase().includes('text/event-stream')) return false;

    return defaultFilter ? defaultFilter(req, res) : true;
  };
}

module.exports = { makeCompressionFilter };
