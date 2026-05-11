'use strict';

/**
 * identify-gpsr-schema.js — zod schema for identify.gpsr Worker.
 *
 * Phase F.3 — Reflects identify-gpsr.json outputSchemaHint:
 *   { ok, domain:'gpsr', resolved:{ manufacturerName, street, city, postalCode, country, email,
 *     phone, registrationNumber, authorizedRep }, confidence, sources, warnings, retriesRequested }
 *
 * Pflicht-Constraints (EU GPSR 2023/988 + Leitfaden Sektion 5 + Sektion 7):
 *   - email: gueltiges Email-Format (z.email).
 *   - country: ISO-3166-Alpha-2 (2 Uppercase-Letters).
 *   - phone: muss mit '+' oder '00' beginnen (international).
 */

const { z } = require('zod');

const ConfidenceField = z.number().min(0).max(1);

const Iso2Country = z.string().regex(/^[A-Z]{2}$/, { message: 'country: ISO-3166-alpha-2 (2 Uppercase-Letters)' });
const PhoneIntl = z.string().regex(/^(\+|00)\d{6,}$/, { message: 'phone: muss mit + oder 00 beginnen (international)' });

const IdentifyGpsrSchema = z.object({
  ok: z.boolean().optional(),
  domain: z.literal('gpsr').optional(),
  resolved: z.object({
    manufacturerName: z.string().nullable().optional(),
    manufacturerAddress: z.string().nullable().optional(),
    street: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    postalCode: z.string().nullable().optional(),
    country: Iso2Country.nullable().optional(),
    email: z.email().nullable().optional(),
    phone: PhoneIntl.nullable().optional(),
    registrationNumber: z.string().nullable().optional(),
    authorizedRep: z.record(z.string(), z.unknown()).nullable().optional(),
  }).passthrough(),
  confidence: z.union([
    ConfidenceField,
    z.object({
      name: ConfidenceField.optional(),
      address: ConfidenceField.optional(),
      contact: ConfidenceField.optional(),
    }).passthrough(),
  ]).optional(),
  sources: z.array(z.object({
    field: z.string().optional(),
    url: z.string().optional(),
    value: z.string().optional(),
  }).passthrough()).optional(),
  warnings: z.array(z.string()).optional(),
  retriesRequested: z.boolean().optional(),
}).passthrough();

module.exports = { IdentifyGpsrSchema };
