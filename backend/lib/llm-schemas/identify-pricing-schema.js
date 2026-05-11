'use strict';

/**
 * identify-pricing-schema.js — zod schema for identify.pricing Worker.
 *
 * Phase F.3 — Reflects identify-pricing.json outputSchemaHint:
 *   { ok, domain:'pricing', resolved:{ recommendedPrice, median, topCompetitor, minRange, maxRange,
 *     delta, currency }, confidence, sources, warnings, retriesRequested }
 *
 * Pflicht-Constraints (Strategischer eBay Leitfaden Sektion 2):
 *   - recommendedPrice >= 1.00 EUR (eBay-Hard-Floor) ODER null.
 *   - currency: 'EUR' (default), erlaubt USD/GBP/CHF/PLN als optional Erweiterung.
 *   - sources: jedes Sold-Listing mit itemId + price + date.
 */

const { z } = require('zod');

const ConfidenceField = z.number().min(0).max(1);

const PriceField = z.number().min(1.0, { message: 'recommendedPrice: eBay Hard-Floor 1.00 EUR' }).nullable();

const IdentifyPricingSchema = z.object({
  ok: z.boolean().optional(),
  domain: z.literal('pricing').optional(),
  resolved: z.object({
    recommendedPrice: PriceField.optional(),
    sellPrice: z.number().positive().nullable().optional(),
    median: z.number().nullable().optional(),
    topCompetitor: z.number().nullable().optional(),
    minRange: z.number().nullable().optional(),
    maxRange: z.number().nullable().optional(),
    delta: z.number().nullable().optional(),
    currency: z.enum(['EUR', 'USD', 'GBP', 'CHF', 'PLN']).optional(),
    breakdown: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
  confidence: ConfidenceField.optional(),
  sources: z.array(z.object({
    itemId: z.string().optional(),
    price: z.number().optional(),
    date: z.string().optional(),
  }).passthrough()).optional(),
  warnings: z.array(z.string()).optional(),
  retriesRequested: z.boolean().optional(),
}).passthrough();

module.exports = { IdentifyPricingSchema };
