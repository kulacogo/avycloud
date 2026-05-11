'use strict';

/**
 * identify-critic-schema.js — zod schema for the identify.critic Worker (Cassini 7-Pillar).
 *
 * Phase F.3 — Reflects identify-critic.json outputSchemaHint:
 *   { title_score, description_score, image_score, specifics_score, compliance_score, overall,
 *     issues:[{ pillar, severity, message, field, suggestion }],
 *     refinement_needed_workers:[string] }
 *
 * Pflicht-Constraints (Strategischer eBay Leitfaden Sektion 1+2 + lib/cassini-scorer.js):
 *   - Alle scores 0..1.
 *   - severity in { error | warning | info }.
 *   - refinement_needed_workers max 4 (kein Total-Rerun).
 */

const { z } = require('zod');

const ScoreField = z.number().min(0).max(1);

const SeverityEnum = z.enum(['error', 'warning', 'info']);
const WorkerNameEnum = z.enum([
  'identity', 'category', 'attributes', 'seo', 'pricing', 'image', 'gpsr',
  'seo_title', 'seo_description',
]);

const IdentifyCriticSchema = z.object({
  overall: ScoreField,
  title_score: ScoreField,
  description_score: ScoreField,
  image_score: ScoreField,
  specifics_score: ScoreField,
  compliance_score: ScoreField,
  issues: z.array(z.object({
    pillar: z.string(),
    severity: SeverityEnum,
    message: z.string(),
    field: z.string().optional(),
    suggestion: z.string().optional(),
  }).passthrough()),
  refinement_needed_workers: z.array(WorkerNameEnum)
    .max(4, { message: 'refinement_needed_workers: max 4 pro Run (kein Total-Rerun)' }),
}).passthrough();

module.exports = { IdentifyCriticSchema };
