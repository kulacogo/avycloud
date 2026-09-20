'use strict';
const { z } = require('zod');

const PackagingIdentitySchema = z.object({
  transcription: z.string().max(12000), brand: z.string().max(200), model: z.string().max(200),
  gtin: z.string().max(30), name: z.string().max(300), conflict: z.boolean(),
  variants: z.array(z.object({ name: z.string().max(80), value: z.string().max(300) })).max(8),
});
const PackagingReferenceSchema = z.object({
  exactModel: z.boolean(), sameVariant: z.boolean(), completeProduct: z.boolean(),
  usablePhoto: z.boolean(), noConflicts: z.boolean(), primaryProduct: z.boolean(),
  includedPartsOnly: z.boolean(),
  confidence: z.number().min(0).max(1), identityQuote: z.string().max(3000),
  variantQuotes: z.array(z.string().max(3000)).max(8),
});
module.exports = { PackagingIdentitySchema, PackagingReferenceSchema };
