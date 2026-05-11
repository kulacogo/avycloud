'use strict';

/**
 * identify-image-schema.js — zod schema for identify.image Worker.
 *
 * Phase F.3 — Reflects identify-image.json outputSchemaHint:
 *   { ok, domain:'image', resolved:{ mainImage:{ url, score, whiteBackground, resolution:{w,h}, watermarkDetected },
 *     orderedImages[], needsImageReplacement, recommendations[], similarityToWinners },
 *     confidence, sources, warnings, retriesRequested }
 *
 * Pflicht-Constraints (Strategischer eBay Leitfaden Sektion 6):
 *   - orderedImages: max 12 (eBay-Limit).
 *   - similarityToWinners: 0..1.
 *   - mainImage.score: 0..1.
 *   - role: 'main'|'video'|'detail'|'lifestyle'|'label'.
 */

const { z } = require('zod');

const ConfidenceField = z.number().min(0).max(1);

const ImageRoleEnum = z.enum(['main', 'video', 'detail', 'lifestyle', 'label']);

const ImageItem = z.object({
  url: z.string().optional(),
  position: z.number().int().min(1).max(12).optional(),
  role: ImageRoleEnum.optional(),
  qualityScore: z.number().min(0).max(1).optional(),
  aiGenerated: z.boolean().optional(),
}).passthrough();

const IdentifyImageSchema = z.object({
  ok: z.boolean().optional(),
  domain: z.literal('image').optional(),
  resolved: z.object({
    images: z.array(z.record(z.string(), z.unknown())).max(12).optional(),
    mainImage: z.object({
      url: z.string().optional(),
      score: ConfidenceField.optional(),
      whiteBackground: z.boolean().optional(),
      resolution: z.object({
        w: z.number().int().positive().optional(),
        h: z.number().int().positive().optional(),
      }).passthrough().optional(),
      watermarkDetected: z.boolean().optional(),
    }).passthrough().optional(),
    orderedImages: z.array(ImageItem).max(12).optional(),
    needsImageReplacement: z.boolean().optional(),
    recommendations: z.array(z.string()).optional(),
    similarityToWinners: ConfidenceField.optional(),
    mainBgWhiteScore: ConfidenceField.optional(),
    issues: z.array(z.string()).optional(),
  }).passthrough(),
  confidence: ConfidenceField.optional(),
  sources: z.array(z.object({
    url: z.string().optional(),
    qualityScore: z.number().optional(),
  }).passthrough()).optional(),
  warnings: z.array(z.string()).optional(),
  retriesRequested: z.boolean().optional(),
}).passthrough();

module.exports = { IdentifyImageSchema };
