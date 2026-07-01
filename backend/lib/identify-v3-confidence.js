'use strict';

/**
 * Resolve the identification confidence that drives the capture-review badge
 * ("Sicher" / "Unsicher" / "Geschätzt").
 *
 * BUG THIS FIXES: assembleProduct() set `identification.confidence = 0.8` with the
 * comment "Will be overwritten by Stage 4" — but Stage 4 only ever wrote its score
 * to `ops.data_quality.identify_v3.overall_score`, never back to
 * `identification.confidence`. So EVERY V3 product kept a hardcoded 0.8 and the UI
 * rendered "Sicher" — even for total-failure fallbacks (name "Produkt",
 * description "<p>Produkt</p>"). This makes the confidence reflect reality.
 *
 * @param {object} stage4  Stage-4 validation result (reads `overallScore`, 0..1).
 * @param {object} stage3  Stage-3 content result (reads `_meta.fallbackUsed`).
 * @returns {number} confidence clamped to [0,1].
 */
function resolveIdentificationConfidence(stage4, stage3) {
  const base = typeof stage4?.overallScore === 'number' ? stage4.overallScore : 0;
  const fallbackUsed = !!(stage3 && stage3._meta && stage3._meta.fallbackUsed);
  // A content fallback means recognition failed (Stage-3 timeout/error/no usable
  // input). Such a placeholder must never be shown as confident, regardless of the
  // composite score — hard-cap it below the "Sicher" and "Unsicher" thresholds.
  const resolved = fallbackUsed ? Math.min(base, 0.3) : base;
  if (!Number.isFinite(resolved)) return 0;
  return Math.max(0, Math.min(1, resolved));
}

module.exports = { resolveIdentificationConfidence };
