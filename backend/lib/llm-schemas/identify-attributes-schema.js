'use strict';

/**
 * identify-attributes-schema.js — zod schema for the identify.attributes Worker.
 *
 * Phase F.3 — Reflects identify-attributes.json outputSchemaHint:
 *   { ok, domain:'attributes', resolved:{ attributes, requiredAspectsCovered, aspectSource },
 *     confidence, sources, warnings, retriesRequested }
 *
 * Pflicht-Constraints:
 *   - attributes: Map<string,string|string[]>; 45-Cap-Enforcement vom Worker-Code (lib/aspect-cap-enforcer.js).
 *     Schema erlaubt bis zu 45 Keys.
 *   - requiredAspectsCovered: 0..1.
 */

const { z } = require('zod');

const ConfidenceField = z.number().min(0).max(1);

const AttributeValue = z.union([z.string(), z.array(z.string())]);

const IdentifyAttributesSchema = z.object({
  ok: z.boolean().optional(),
  domain: z.literal('attributes').optional(),
  resolved: z.object({
    attributes: z.record(z.string(), AttributeValue).refine(
      (obj) => Object.keys(obj).length <= 45,
      { message: 'attributes: maximum 45 keys (eBay 45-cap)' }
    ),
    requiredAspectsCovered: ConfidenceField.optional(),
    aspectSource: z.record(z.string(), z.string()).optional(),
    missingRequired: z.array(z.string()).optional(),
  }).passthrough(),
  confidence: ConfidenceField.optional(),
  sources: z.array(z.object({
    aspect: z.string().optional(),
    source: z.string().optional(),
    value: z.string().optional(),
  }).passthrough()).optional(),
  warnings: z.array(z.string()).optional(),
  retriesRequested: z.boolean().optional(),
}).passthrough();

module.exports = { IdentifyAttributesSchema };
