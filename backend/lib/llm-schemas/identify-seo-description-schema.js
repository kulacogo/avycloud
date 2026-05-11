'use strict';

/**
 * identify-seo-description-schema.js — zod schema for identify.seo_description Worker.
 *
 * Phase F.3 — Reflects identify-seo-description.json outputSchemaHint:
 *   { ok, domain:'seo_description', resolved:{ html, plainText, wordCount, keywordDensity, mobileSnippet, spammingRisk? },
 *     confidence, sources, warnings, retriesRequested }
 *
 * Pflicht-Constraints (Strategischer eBay Leitfaden Sektion 4 + Sektion 5 + Sektion 7):
 *   - mobileSnippet: max 800 Zeichen.
 *   - wordCount: 180-240 (Toleranz, refine warnt aber blockt nicht).
 *   - keywordDensity.overall: 0..1.
 *   - html: kein Active-Content (script/iframe/form/javascript:).
 *   - spammingRisk: optionales Output-Feld (Section 7 Compliance — Keyword-Spamming).
 *     Wird via `.transform()` automatisch gesetzt wenn max-Token-Density im
 *     description-Text > 7 % ist. Bestehende Outputs ohne spammingRisk werden
 *     unverändert akzeptiert (backwards-compat).
 */

const { z } = require('zod');
const { detectKeywordSpamming } = require('../cassini-scorer');

const ACTIVE_CONTENT_PATTERN = /<\s*script\b|<\s*iframe\b|<\s*object\b|<\s*embed\b|<\s*form\b|javascript:/i;
const DensityField = z.number().min(0).max(1);
const ConfidenceField = z.number().min(0).max(1);

const HtmlField = z.string().refine(
  (s) => !ACTIVE_CONTENT_PATTERN.test(s),
  { message: 'html: enthaelt Active Content (script/iframe/form/javascript:) — Compliance-Verstoss' }
);

const IdentifySeoDescriptionSchema = z.object({
  ok: z.boolean().optional(),
  domain: z.literal('seo_description').optional(),
  resolved: z.object({
    html: HtmlField.optional(),
    description: z.string().optional(),
    plainText: z.string().optional(),
    wordCount: z.number().int().min(0).optional(),
    keywordDensity: z.union([
      DensityField,
      z.object({
        perKeyword: z.record(z.string(), z.number()).optional(),
        overall: DensityField.optional(),
      }).passthrough(),
    ]).optional(),
    mobileSnippet: z.string().max(800).nullable().optional(),
    // F.3 — optional Output-Flag, additiv. Bestehende Outputs ohne spammingRisk
    // bleiben validierbar (backwards-compat). Wird via .transform() automatisch
    // berechnet wenn LLM-Output nichts liefert.
    spammingRisk: z.boolean().optional(),
  }).passthrough(),
  confidence: ConfidenceField.optional(),
  sources: z.array(z.unknown()).optional(),
  warnings: z.array(z.string()).optional(),
  retriesRequested: z.boolean().optional(),
}).passthrough().transform((data) => {
  // F.3 — Auto-detect Keyword-Spamming wenn LLM den Flag nicht selber gesetzt
  // hat. detectKeywordSpamming() ist pure (lib/cassini-scorer.js), max-Token-
  // Density-Schwelle 7 % (Sektion 7 Compliance).
  if (data && data.resolved && typeof data.resolved === 'object') {
    if (data.resolved.spammingRisk === undefined) {
      const text =
        (typeof data.resolved.plainText === 'string' && data.resolved.plainText) ||
        (typeof data.resolved.html === 'string' && data.resolved.html) ||
        (typeof data.resolved.description === 'string' && data.resolved.description) ||
        '';
      if (text) {
        try {
          data.resolved.spammingRisk = detectKeywordSpamming(text, 0.07);
        } catch (_err) {
          // defensive: never block validation on a helper-bug.
        }
      }
    }
  }
  return data;
});

module.exports = { IdentifySeoDescriptionSchema, ACTIVE_CONTENT_PATTERN };
