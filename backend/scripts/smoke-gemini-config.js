'use strict';

/**
 * smoke-gemini-config.js — Pre-rollout verifier for chat pipeline configs.
 *
 * Sends MINIMAL real Gemini API requests with the exact config shape used by
 * V2 (CHAT_V2_ENHANCED=true), V3 (CHAT_V3=true), and Legacy (CHAT_LEGACY_ENHANCED=true)
 * so we can detect whether the v1beta API accepts the current config before we
 * flip the feature flags in Cloud Run.
 *
 * Usage:
 *   GEMINI_API_KEY=... node backend/scripts/smoke-gemini-config.js
 *
 * Exits 0 if all three pipelines accept the config, 1 otherwise.
 * Prints a JSON result blob to stdout for machine consumption.
 */

const MODEL = process.env.SMOKE_MODEL || 'gemini-3.7-flash';
// Thinking models (V2/V3 with thinkingLevel=high) can legitimately take 20-40s
// even on minimal prompts, so we give each call 60s to prove config validity.
// A timeout is NOT a config rejection — rerun if hit.
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 60000);

function hasApiKey() {
  return Boolean(
    (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim()) ||
      (process.env.GOOGLE_GENAI_API_KEY && process.env.GOOGLE_GENAI_API_KEY.trim())
  );
}

// Normalize error shapes from both SDKs into a printable string that preserves
// the full API error body (status, details) when available.
function formatError(err) {
  if (!err) return 'unknown error';
  const parts = [];
  if (err.status != null) parts.push(`status=${err.status}`);
  if (err.code != null) parts.push(`code=${err.code}`);
  if (err.statusText) parts.push(`statusText=${err.statusText}`);
  const msg = err.message || String(err);
  parts.push(`message=${msg}`);
  // Try to surface the raw API body if the SDK attached one.
  const bodies = [];
  if (err.response) {
    try { bodies.push('response=' + JSON.stringify(err.response).slice(0, 2000)); } catch {}
  }
  if (err.cause && err.cause !== err) {
    bodies.push('cause=' + (err.cause.message || String(err.cause)));
    if (err.cause.response) {
      try { bodies.push('causeResponse=' + JSON.stringify(err.cause.response).slice(0, 2000)); } catch {}
    }
  }
  return [parts.join(' '), ...bodies].filter(Boolean).join('\n  ');
}

function responsePreview(resp, maxLen = 120) {
  try {
    const text = typeof resp?.text === 'function' ? resp.text() : resp?.text;
    const s = typeof text === 'string' ? text : resp?.response?.text?.();
    return typeof s === 'string' ? s.slice(0, maxLen) : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// V2 — product-chat-v2.js config when CHAT_V2_ENHANCED=true
// Mirrors: runProductChatV2 -> chatConfig + tools + ai.chats.create()
// ---------------------------------------------------------------------------

async function testV2Config() {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY });

  const tools = [
    { googleSearch: {} },
    { urlContext: {} },
    {
      functionDeclarations: [
        {
          name: 'update_product_datasheet',
          description: 'Propose structured changes to the product datasheet.',
          parameters: {
            type: 'OBJECT',
            properties: {
              summary: { type: 'STRING' },
              title: { type: 'STRING' },
            },
          },
        },
      ],
    },
  ];

  const chatConfig = {
    tools,
    toolConfig: {
      includeServerSideToolInvocations: true,
    },
    systemInstruction: 'You are a test bot. Respond with just "ok".',
    temperature: 1.0,
    maxOutputTokens: 32,
    thinkingConfig: {
      thinkingLevel: 'high',
      includeThoughts: true,
    },
  };

  const chat = ai.chats.create({
    model: MODEL,
    config: chatConfig,
    history: [],
  });

  const resp = await Promise.race([
    chat.sendMessage({ message: 'Hi, respond with just "ok".' }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`V2 timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)),
  ]);

  return { ok: true, pipeline: 'v2', model: MODEL, responsePreview: responsePreview(resp) };
}

// ---------------------------------------------------------------------------
// V3 — product-chat-v3.js config when CHAT_V3=true
// Mirrors: runProductChatV3 -> config (with safety + thinking + toolConfig.functionCallingConfig)
// ---------------------------------------------------------------------------

async function testV3Config() {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY });

  // Single dummy atomic-tool declaration representative of buildToolList() shape.
  const atomicDummy = {
    name: 'lookup_gtin',
    description: 'Look up product information by GTIN/EAN/UPC barcode.',
    parameters: {
      type: 'object',
      properties: {
        gtin: { type: 'string', description: 'The GTIN/EAN/UPC barcode' },
        locale: { type: 'string' },
      },
      required: ['gtin'],
    },
  };

  const tools = [
    { googleSearch: {} },
    { urlContext: {} },
    {
      functionDeclarations: [
        atomicDummy,
        {
          name: 'update_product_datasheet',
          description: 'Propose structured changes to the product datasheet.',
          parameters: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              title: { type: 'string' },
              confidence: { type: 'number' },
            },
          },
        },
      ],
    },
  ];

  const config = {
    temperature: 1.0,
    maxOutputTokens: 32,
    thinkingConfig: { thinkingLevel: 'high', includeThoughts: true },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
    tools,
    toolConfig: {
      functionCallingConfig: { mode: 'AUTO' },
      includeServerSideToolInvocations: true,
    },
    systemInstruction: 'You are a test bot. Respond with just "ok".',
  };

  const chat = ai.chats.create({ model: MODEL, config, history: [] });

  const resp = await Promise.race([
    chat.sendMessage({ message: [{ text: 'Hi, respond with just "ok".' }] }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`V3 timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)),
  ]);

  return { ok: true, pipeline: 'v3', model: MODEL, responsePreview: responsePreview(resp) };
}

// ---------------------------------------------------------------------------
// Legacy — product-chat.js config using @google/generative-ai (old SDK)
// Mirrors: client.getGenerativeModel({ model, tools, systemInstruction })
// + model.startChat({ history }) + chat.sendMessage()
// Note: Legacy pipeline does NOT pass thinkingConfig (comment at line ~2358).
// ---------------------------------------------------------------------------

async function testLegacyConfig() {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const client = new GoogleGenerativeAI(
    process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY
  );

  // Representative tool declaration (mirrors toGeminiTool(updateDatasheetTool) output).
  const tools = [
    {
      functionDeclarations: [
        {
          name: 'update_product_datasheet',
          description: 'Propose structured changes to the product datasheet.',
          parameters: {
            type: 'object',
            properties: {
              summary: { type: 'string' },
              title: { type: 'string' },
            },
          },
        },
      ],
    },
  ];

  const model = client.getGenerativeModel({
    model: MODEL,
    tools,
    systemInstruction: 'You are a test bot. Respond with just "ok".',
  });

  const chat = model.startChat({ history: [] });

  const resp = await Promise.race([
    chat.sendMessage('Hi, respond with just "ok".'),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Legacy timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS)),
  ]);

  return {
    ok: true,
    pipeline: 'legacy',
    model: MODEL,
    responsePreview: (resp?.response?.text?.() || '').slice(0, 120),
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  if (!hasApiKey()) {
    console.error('GEMINI_API_KEY (or GOOGLE_GENAI_API_KEY) not set. Aborting.');
    console.error('Run: GEMINI_API_KEY=$(gcloud secrets versions access latest --secret=GEMINI_API_KEY) node backend/scripts/smoke-gemini-config.js');
    process.exit(2);
  }

  console.log(`Smoke-testing Gemini configs against model=${MODEL}`);

  const results = {};

  // Run sequentially so each error line is clearly attributable.
  try {
    results.v2 = await testV2Config();
  } catch (err) {
    results.v2 = { ok: false, pipeline: 'v2', error: formatError(err) };
  }
  try {
    results.v3 = await testV3Config();
  } catch (err) {
    results.v3 = { ok: false, pipeline: 'v3', error: formatError(err) };
  }
  try {
    results.legacy = await testLegacyConfig();
  } catch (err) {
    results.legacy = { ok: false, pipeline: 'legacy', error: formatError(err) };
  }

  console.log('\n=== RESULTS ===');
  console.log(JSON.stringify(results, null, 2));

  const allOk = Object.values(results).every((r) => r?.ok === true);
  console.log(`\n=== SUMMARY: ${allOk ? 'ALL PASSED' : 'FAILURES PRESENT'} ===`);
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('Unexpected top-level failure:', formatError(err));
  process.exit(3);
});
