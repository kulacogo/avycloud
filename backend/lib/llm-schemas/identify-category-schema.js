'use strict';

/**
 * identify-category-schema.js — zod schema for the identify.category Worker.
 *
 * Phase F.3 — Reflects identify-category.json outputSchemaHint:
 *   { ok, domain:'category', resolved:{categoryId, categoryName, categoryBreadcrumb[], categorySource},
 *     confidence, sources, warnings, retriesRequested }
 *
 * Pflicht-Constraints:
 *   - categorySource: enum aus 'auto:catalog'|'auto:suggestions'|'auto:local'|'auto:gemini' (manual = vom UI)
 *   - confidence: 0..1; Schreibfreigabe >= 0.85 ist Aufgabe des Worker-Codes, nicht Schema.
 */

const { z } = require('zod');

const ConfidenceField = z.number().min(0).max(1);

const CategorySourceEnum = z.enum([
  'auto:catalog',
  'auto:suggestions',
  'auto:local',
  'auto:gemini',
  'manual',
]);

const IdentifyCategorySchema = z.object({
  ok: z.boolean().optional(),
  domain: z.literal('category').optional(),
  resolved: z.object({
    categoryId: z.string().nullable().optional(),
    categoryName: z.string().nullable().optional(),
    categoryBreadcrumb: z.array(z.string()).nullable().optional(),
    breadcrumb: z.array(z.string()).nullable().optional(),
    categorySource: CategorySourceEnum.nullable().optional(),
  }).passthrough(),
  confidence: ConfidenceField.optional(),
  sources: z.array(z.object({
    strategy: z.string().optional(),
    score: z.number().optional(),
  }).passthrough()).optional(),
  warnings: z.array(z.string()).optional(),
  retriesRequested: z.boolean().optional(),
}).passthrough();

module.exports = { IdentifyCategorySchema };
