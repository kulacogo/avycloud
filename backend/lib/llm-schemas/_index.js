'use strict';

/**
 * lib/llm-schemas/_index.js — Phase F.3 zod-Schema Lookup-Map.
 *
 * Maps scopeId (from lib/llm-prompts/scopes/*.json) and friendly alias names
 * to their corresponding zod schemas. The helper-layer
 * (gemini3-client / gemini-structured) uses this to look up a schema by
 * scopeConfig.outputSchemaHint OR scopeConfig.scopeId.
 *
 * Stufe 1 (default): safeParse + warn (LLM_SCHEMA_STRICT=false).
 * Stufe 2 (LLM_SCHEMA_STRICT=true): parse + throw.
 *
 * ENV-Vars:
 *   LLM_SCHEMA_STRICT          'false' (default) | 'true'
 *   LLM_SCHEMA_VALIDATE_RATE   '1.0' (default) — sample-rate for Stufe-1-Logging
 *
 * Adding a new schema:
 *   1. Create lib/llm-schemas/<scope-domain>-schema.js exporting `<Name>Schema`.
 *   2. Register it below in SCHEMA_REGISTRY under both scopeId and short alias.
 *   3. Add a parity test in __tests__/lib/llm-schemas/parity.test.js.
 */

const { IdentifyIdentitySchema } = require('./identify-identity-schema');
const { IdentifyCategorySchema } = require('./identify-category-schema');
const { IdentifyAttributesSchema } = require('./identify-attributes-schema');
const { IdentifySeoTitleSchema } = require('./identify-seo-title-schema');
const { IdentifySeoDescriptionSchema } = require('./identify-seo-description-schema');
const { IdentifyPricingSchema } = require('./identify-pricing-schema');
const { IdentifyImageSchema } = require('./identify-image-schema');
const { IdentifyGpsrSchema } = require('./identify-gpsr-schema');
const { IdentifyCriticSchema } = require('./identify-critic-schema');
const { ChatContextSchema } = require('./chat-context-schema');
const { ChatUpdateDatasheetSchema } = require('./chat-update-datasheet-schema');
const { QualityGateSchema } = require('./quality-gate-schema');

// Map both canonical scopeIds and friendly aliases to the schema object.
const SCHEMA_REGISTRY = Object.freeze({
  // identify.* scopes
  'identify.identity': IdentifyIdentitySchema,
  'identify.category': IdentifyCategorySchema,
  'identify.attributes': IdentifyAttributesSchema,
  'identify.seo_title': IdentifySeoTitleSchema,
  'identify.seo_description': IdentifySeoDescriptionSchema,
  'identify.pricing': IdentifyPricingSchema,
  'identify.image': IdentifyImageSchema,
  'identify.gpsr': IdentifyGpsrSchema,
  'identify.critic': IdentifyCriticSchema,

  // chat.* scopes
  'chat.product': ChatContextSchema,
  'chat.context': ChatContextSchema,
  'chat.update_datasheet': ChatUpdateDatasheetSchema,

  // quality scopes
  'quality.gate': QualityGateSchema,

  // friendly aliases (used by outputSchemaHint strings if callers prefer)
  identity: IdentifyIdentitySchema,
  category: IdentifyCategorySchema,
  attributes: IdentifyAttributesSchema,
  seo_title: IdentifySeoTitleSchema,
  seo_description: IdentifySeoDescriptionSchema,
  pricing: IdentifyPricingSchema,
  image: IdentifyImageSchema,
  gpsr: IdentifyGpsrSchema,
  critic: IdentifyCriticSchema,
  chat_context: ChatContextSchema,
  chat_update_datasheet: ChatUpdateDatasheetSchema,
  quality_gate: QualityGateSchema,
});

/**
 * Lookup a zod schema by scopeId / hint / alias.
 * Returns null if unknown — caller should NOT throw on unknown (additive).
 *
 * @param {string} name
 * @returns {import('zod').ZodTypeAny | null}
 */
function getSchemaForScope(name) {
  if (!name || typeof name !== 'string') return null;
  return SCHEMA_REGISTRY[name] || null;
}

/**
 * Read LLM_SCHEMA_STRICT env (cached per call — env can change in tests).
 */
function isStrictMode() {
  const raw = String(process.env.LLM_SCHEMA_STRICT || 'false').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/**
 * Read LLM_SCHEMA_VALIDATE_RATE env (0.0..1.0). Default 1.0 (always validate
 * + log on failure). Values outside [0, 1] clamp to 1.0.
 */
function validateRate() {
  const raw = process.env.LLM_SCHEMA_VALIDATE_RATE;
  if (raw == null || String(raw).trim() === '') return 1.0;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return 1.0;
  return n;
}

module.exports = {
  SCHEMA_REGISTRY,
  getSchemaForScope,
  isStrictMode,
  validateRate,
};
