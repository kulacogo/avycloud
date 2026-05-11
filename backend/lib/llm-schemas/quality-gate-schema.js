'use strict';

/**
 * quality-gate-schema.js — zod schema for the quality.gate Reviewer.
 *
 * Phase F.3 — Reflects quality-gate.json outputSchemaHint:
 *   { ok: boolean, can_publish: boolean, plausibility_score: number,
 *     issues:[{ code, severity:'error'|'warning'|'info', message, field?, suggestion? }] }
 *
 * Pflicht-Constraints (Strategischer eBay Leitfaden Sektion 7):
 *   - plausibility_score: 0..1.
 *   - severity enum.
 *   - issues: max 20 (Leitfaden + scope rule).
 */

const { z } = require('zod');

const ConfidenceField = z.number().min(0).max(1);
const SeverityEnum = z.enum(['error', 'warning', 'info']);

const QualityGateSchema = z.object({
  ok: z.boolean(),
  can_publish: z.boolean(),
  plausibility_score: ConfidenceField,
  issues: z.array(z.object({
    code: z.string(),
    severity: SeverityEnum,
    message: z.string(),
    field: z.string().optional(),
    suggestion: z.string().optional(),
  }).passthrough()).max(20),
}).passthrough();

module.exports = { QualityGateSchema };
