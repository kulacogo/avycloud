'use strict';

/**
 * chat-update-datasheet-schema.js — zod schema for the chat.update_datasheet Tool-Call.
 *
 * Phase F.3 — Reflects chat-update-datasheet.json outputSchemaHint + the
 * sanitizeDatasheetChange whitelist from services/product-chat-v3.js +
 * services/product-chat-v2.js.
 *
 * Whitelist:
 *   summary, title (max 120), confidence (0..1), short_description (max 8000),
 *   key_features[] (max 12, je 240 chars), identity{...,clear:['barcodes'|'ean'|'gtin'|'upc']},
 *   attributes[] (max 40, key max 60, value max 240), gpsr{...}, pricing{amount,currency,note},
 *   notes{warnings[], sources[], evidence[]}.
 */

const { z } = require('zod');

const ConfidenceField = z.number().min(0).max(1);

const IdentityClearEnum = z.enum(['barcodes', 'ean', 'gtin', 'upc']);

const IdentityBlock = z.object({
  ean: z.string().optional(),
  gtin: z.string().optional(),
  upc: z.string().optional(),
  mpn: z.string().optional(),
  brand: z.string().optional(),
  model: z.string().optional(),
  clear: z.array(IdentityClearEnum).optional(),
}).passthrough();

const AttributeItem = z.object({
  key: z.string().max(60),
  value: z.string().max(240),
  value_type: z.string().optional(),
}).passthrough();

const PricingBlock = z.object({
  amount: z.number().min(1.0).optional(),
  currency: z.string().optional(),
  note: z.string().optional(),
}).passthrough();

const NotesBlock = z.object({
  warnings: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  evidence: z.array(z.string()).optional(),
}).passthrough();

const GpsrBlock = z.object({
  manufacturer_name: z.string().optional(),
  manufacturer_address: z.string().optional(),
  manufacturer_city: z.string().optional(),
  manufacturer_postal: z.string().optional(),
  manufacturer_country: z.string().optional(),
  manufacturer_email: z.string().optional(),
  manufacturer_phone: z.string().optional(),
  eu_responsible_name: z.string().optional(),
  eu_responsible_address: z.string().optional(),
  eu_responsible_email: z.string().optional(),
  eu_responsible_phone: z.string().optional(),
}).passthrough();

const ChatUpdateDatasheetSchema = z.object({
  summary: z.string().max(500),
  confidence: ConfidenceField,
  title: z.string().max(120).optional(),
  short_description: z.string().max(8000).optional(),
  key_features: z.array(z.string().max(240)).max(12).optional(),
  identity: IdentityBlock.optional(),
  attributes: z.array(AttributeItem).max(40).optional(),
  gpsr: GpsrBlock.optional(),
  pricing: PricingBlock.optional(),
  notes: NotesBlock.optional(),
}).passthrough();

module.exports = { ChatUpdateDatasheetSchema };
