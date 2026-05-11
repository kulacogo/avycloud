'use strict';

/**
 * chat-context-schema.js — zod schema for the chat.product context output.
 *
 * Phase F.3 — Reflects chat-context.json outputSchemaHint:
 *   { answer: string, sources: [{ url, title }], warnings: [string] }
 *
 * Minimal context shape — chat is conversational and may stream partial text;
 * the schema therefore allows additional fields via passthrough().
 */

const { z } = require('zod');

const ChatContextSchema = z.object({
  answer: z.string(),
  sources: z.array(z.object({
    url: z.string().optional(),
    title: z.string().optional(),
  }).passthrough()).optional(),
  warnings: z.array(z.string()).optional(),
}).passthrough();

module.exports = { ChatContextSchema };
