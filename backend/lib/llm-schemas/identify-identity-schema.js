'use strict';

/**
 * identify-identity-schema.js — zod schema for the identify.identity Worker.
 *
 * Phase F.3 — 2-stufige Schema-Validation. Stufe 1 (default): safeParse + warn.
 * Stufe 2 (LLM_SCHEMA_STRICT=true): parse + throw.
 *
 * Reflects the scope outputSchemaHint from
 * lib/llm-prompts/scopes/identify-identity.json:
 *   { ok, domain:'identity', resolved:{brand,model,gtin,mpn}, confidence:{...}, sources, warnings, retriesRequested }
 *
 * Pflicht-Constraints:
 *   - GTIN: 8/12/13/14-stellig (Pruefziffer-Check ist Aufgabe der Worker, hier nur Format)
 *   - Confidence per field 0..1 (Strategischer eBay Leitfaden Sektion 5)
 */

const { z } = require('zod');

const ConfidenceField = z.number().min(0).max(1);
const GtinRegex = /^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/;

const IdentifyIdentitySchema = z.object({
  ok: z.boolean().optional(),
  domain: z.literal('identity').optional(),
  resolved: z.object({
    brand: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    gtin: z.string().regex(GtinRegex).nullable().optional(),
    mpn: z.string().nullable().optional(),
  }).passthrough(),
  confidence: z.union([
    ConfidenceField,
    z.object({
      brand: ConfidenceField.optional(),
      model: ConfidenceField.optional(),
      gtin: ConfidenceField.optional(),
      mpn: ConfidenceField.optional(),
    }).passthrough(),
  ]).optional(),
  sources: z.array(z.object({
    url: z.string().optional(),
    field: z.string().optional(),
    value: z.string().optional(),
  }).passthrough()).optional(),
  warnings: z.array(z.string()).optional(),
  retriesRequested: z.boolean().optional(),
}).passthrough();

module.exports = { IdentifyIdentitySchema };
