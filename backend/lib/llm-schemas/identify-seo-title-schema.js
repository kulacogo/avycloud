'use strict';

/**
 * identify-seo-title-schema.js — zod schema for the identify.seo_title Worker.
 *
 * Phase F.3 — Reflects identify-seo-title.json outputSchemaHint:
 *   { ok, domain:'seo_title', resolved:{ title, mobilePreview, chars, injectedKeywords[], patternUsed },
 *     confidence, sources, warnings, retriesRequested }
 *
 * Pflicht-Constraints (Strategischer eBay Leitfaden Sektion 3 — 80-Zeichen-Meisterschaft):
 *   - title: max 80 Zeichen.
 *   - title: keine verbotenen Sonderzeichen ('&', '!', '_', '--', 'WOW', 'L@@K')
 *     => refine() with TITLE_BAD_CHAR_PATTERN.
 *   - title: keine Bad-Prefixes ('NEU:', 'TOP:', 'ANGEBOT:', 'PREMIUM:', 'ORIGINAL:', 'RABATT:')
 *     => refine().
 */

const { z } = require('zod');

const ConfidenceField = z.number().min(0).max(1);

const TITLE_BAD_CHAR_PATTERN = /[&!_]|--|WOW|L@@K/i;
const TITLE_BAD_PREFIX = /^\s*(NEU|TOP|ANGEBOT|PREMIUM|ORIGINAL|RABATT)\s*:/i;

const TitleField = z.string()
  .max(80, { message: 'title: max 80 Zeichen (eBay-Limit)' })
  .refine((t) => !TITLE_BAD_CHAR_PATTERN.test(t), { message: 'title: enthaelt verbotene Sonderzeichen' })
  .refine((t) => !TITLE_BAD_PREFIX.test(t), { message: 'title: verbotener Bad-Prefix (NEU/TOP/ANGEBOT/...)' });

const IdentifySeoTitleSchema = z.object({
  ok: z.boolean().optional(),
  domain: z.literal('seo_title').optional(),
  resolved: z.object({
    title: TitleField,
    mobilePreview: z.string().max(80).optional(),
    chars: z.number().int().min(0).max(80).optional(),
    injectedKeywords: z.array(z.string()).optional(),
    patternUsed: z.string().optional(),
  }).passthrough(),
  confidence: ConfidenceField.optional(),
  sources: z.array(z.object({
    competitor: z.string().optional(),
    keyword: z.string().optional(),
  }).passthrough()).optional(),
  warnings: z.array(z.string()).optional(),
  retriesRequested: z.boolean().optional(),
}).passthrough();

module.exports = { IdentifySeoTitleSchema, TITLE_BAD_CHAR_PATTERN, TITLE_BAD_PREFIX };
