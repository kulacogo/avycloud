'use strict';

/**
 * identity-worker.js — Identify-V4 Worker-Agent for the IDENTITY domain
 * (GTIN/EAN/UPC, MPN, and canonical Brand resolution).
 *
 * Contract (see backend/docs/features/identify-v4 spec):
 *   async function runIdentityWorker(context) -> {
 *     ok, domain: 'identity', resolved, confidence, sources,
 *     retriesRequested, meta: { durationMs, tokensUsed, toolsCalled, geminiCalls, error }
 *   }
 *
 * Behaviour:
 *   1. Collect GTIN candidates from context.barcodes + context.ocrPayload.text
 *      (regex 8/12/13/14-digit sequences).
 *   2. Validate via lib/gtin.isValidGtin (mod-10 checksum).
 *   3. If a valid GTIN exists: call executors in parallel
 *      (executeLookupGtin, executeVerifyBrand, executeSearchAmazonProduct).
 *   4. If no valid GTIN AND context.aiClient is provided: run a focused
 *      Gemini 3.1 Pro agentic loop (max 4 iterations, forced finalization
 *      via mode=ANY + allowedFunctionNames=['finalize_identity']).
 *   5. Merge results via resolveConsensus from cross-reference.js.
 *   6. Score confidence per-field via scoreField from confidence-scoring.js.
 *   7. NEVER throws — always returns a plain result object; errors surface in
 *      meta.error.
 */

const atomicTools = require('../../services/atomic-tools');
const { scoreField } = require('../confidence-scoring');
const { resolveConsensus } = require('../cross-reference');
const { isValidGtin, normalizeDigits } = require('../gtin');
const {
  resolveChatModel,
  defaultThinkingConfig,
  defaultSafetySettings,
  DEFAULT_CHAT_TEMPERATURE,
} = require('../gemini-config');

const DOMAIN = 'identity';
const MAX_WORKER_ITERATIONS = 4;
const MAX_OUTPUT_TOKENS = 4096;
const GTIN_REGEX = /\b\d{8,14}\b/g;
const FINALIZE_TOOL = 'finalize_identity';

// Function-calling mode helpers (same pattern as product-chat-v3.js so the
// worker degrades gracefully when @google/genai is unavailable in tests).
let FunctionCallingConfigMode;
try {
  // eslint-disable-next-line global-require
  ({ FunctionCallingConfigMode } = require('@google/genai'));
} catch (err) {
  FunctionCallingConfigMode = { AUTO: 'AUTO', ANY: 'ANY', NONE: 'NONE' };
}
if (!FunctionCallingConfigMode || !FunctionCallingConfigMode.ANY) {
  FunctionCallingConfigMode = { AUTO: 'AUTO', ANY: 'ANY', NONE: 'NONE' };
}

// ---------------------------------------------------------------------------
// Source-weight mapping (mirrors product-chat-v3 / confidence-scoring).
// ---------------------------------------------------------------------------

const ATOMIC_SOURCE_TO_WEIGHT_KEY = Object.freeze({
  lookup_gtin: 'ean_db',
  search_ebay_catalog: 'ebay_catalog',
  verify_brand: 'gs1_verified',
  search_amazon_product: 'amazon_product',
  search_manufacturer_site: 'manufacturer_website',
  fetch_url_content: 'url_context',
});

function mapToolSourceWeight(source) {
  return ATOMIC_SOURCE_TO_WEIGHT_KEY[source] || 'web_search_broad';
}

// ---------------------------------------------------------------------------
// Finalize-tool declaration — minimal payload for the Gemini-fallback path.
// ---------------------------------------------------------------------------

const FINALIZE_IDENTITY_DECLARATION = {
  name: 'finalize_identity',
  description:
    'Finalize the identity resolution. Return the best-guess values for ' +
    'gtin/ean/upc, brand (canonical, without GmbH/AG/Inc suffix), and mpn. ' +
    'If unsure, set confidence < 0.5 rather than hallucinate.',
  parameters: {
    type: 'object',
    properties: {
      gtin: { type: 'string' },
      ean: { type: 'string' },
      upc: { type: 'string' },
      brand: { type: 'string' },
      mpn: { type: 'string' },
      confidence: { type: 'number' },
      rationale: { type: 'string' },
    },
  },
};

const SYSTEM_PROMPT = [
  'Du bist ein GTIN/Brand-Identity-Resolver.',
  'Finde für das Produkt mit minimalem Input:',
  '- die korrekte GTIN/EAN/UPC (13 Ziffern bevorzugt)',
  '- die canonical Brand (ohne GmbH/AG/Inc Suffix)',
  '- die Manufacturer Part Number (MPN)',
  'Nutze die atomic tools: lookup_gtin, verify_brand, search_amazon_product.',
  'Cross-referenziere 2+ Quellen. Antworte am ENDE mit einem function_call an finalize_identity',
  '(keine Prosa). Wenn Info unklar: confidence < 0.5 setzen, nicht halluzinieren.',
].join('\n');

// ---------------------------------------------------------------------------
// GTIN candidate extraction + dedupe
// ---------------------------------------------------------------------------

function extractCandidatesFromBarcodes(barcodes) {
  if (!barcodes) return [];
  if (Array.isArray(barcodes)) {
    return barcodes
      .map((b) => (b && typeof b === 'object' ? b.value || b.barcode || b.code : b))
      .filter(Boolean)
      .map((b) => String(b));
  }
  if (typeof barcodes === 'string') {
    return barcodes.split(/[\s,;|]+/).filter(Boolean);
  }
  return [];
}

function extractCandidatesFromText(text) {
  if (typeof text !== 'string' || !text) return [];
  const matches = text.match(GTIN_REGEX) || [];
  return matches.map((m) => String(m));
}

function collectValidGtins(context) {
  const fromBarcodes = extractCandidatesFromBarcodes(context?.barcodes);
  const fromOcr = extractCandidatesFromText(context?.ocrPayload?.text || '');
  const seen = new Set();
  const valid = [];
  for (const candidate of [...fromBarcodes, ...fromOcr]) {
    const digits = normalizeDigits(String(candidate || ''));
    if (!digits || seen.has(digits)) continue;
    seen.add(digits);
    if (isValidGtin(digits)) {
      valid.push(digits);
    }
  }
  return valid;
}

function pickPrimaryGtin(validGtins) {
  if (!Array.isArray(validGtins) || !validGtins.length) return null;
  // Prefer 13-digit EAN, then 14, then 12, then 8.
  const preference = [13, 14, 12, 8];
  for (const len of preference) {
    const found = validGtins.find((g) => g.length === len);
    if (found) return found;
  }
  return validGtins[0];
}

// ---------------------------------------------------------------------------
// Evidence extraction from atomic-tool results
// ---------------------------------------------------------------------------

function stripCorporateSuffix(value) {
  if (!value || typeof value !== 'string') return value;
  return value
    .replace(/\s+(gmbh|ag|se|inc|ltd|llc|kg|bv|sa|co|corp|corporation)\.?\s*$/i, '')
    .trim();
}

function evidenceFromToolResult(result, sharedGtin) {
  const rows = [];
  const citations = [];
  if (!result || !result.ok || !result.data) return { rows, citations };
  const weightKey = mapToolSourceWeight(result.source);
  const data = result.data;
  const conf = typeof result.confidence === 'number' ? result.confidence : 0.5;

  switch (result.source) {
    case 'lookup_gtin':
      if (Array.isArray(data.sources)) {
        for (const src of data.sources) {
          const d = (src && src.data) || {};
          const subConf = typeof src.confidence === 'number' ? src.confidence : conf;
          if (d.brand) {
            rows.push({
              field: 'brand',
              source: weightKey,
              value: stripCorporateSuffix(d.brand),
              confidence: subConf,
            });
          }
          if (d.mpn) {
            rows.push({ field: 'mpn', source: weightKey, value: d.mpn, confidence: subConf });
          }
          if (d.gtin || d.ean || d.barcode) {
            const g = normalizeDigits(String(d.gtin || d.ean || d.barcode));
            if (g && isValidGtin(g)) {
              rows.push({ field: 'gtin', source: weightKey, value: g, confidence: subConf });
            }
          }
        }
      }
      if (sharedGtin) {
        // The lookup was performed FOR this gtin — so the gtin itself
        // is corroborated by the lookup at the lookup's own confidence.
        rows.push({ field: 'gtin', source: weightKey, value: sharedGtin, confidence: conf });
      }
      break;

    case 'verify_brand': {
      const brand = data.brand;
      if (brand) {
        rows.push({
          field: 'brand',
          source: weightKey,
          value: stripCorporateSuffix(brand),
          confidence: conf,
        });
      }
      if (data.mpn) {
        rows.push({ field: 'mpn', source: weightKey, value: data.mpn, confidence: conf });
      }
      break;
    }

    case 'search_amazon_product': {
      // Amazon doesn't always give us a structured brand/mpn, but it IS a
      // corroborating signal that a given GTIN exists. When the executor
      // returns a summary/title containing the brand query value, we add a
      // mild citation so the UI can show evidence.
      if (data?.result?.url || data?.url) {
        citations.push({
          type: 'amazon',
          url: data.url || data.result?.url,
          data: data.result || data,
          weight: conf,
        });
      } else if (data?.query) {
        citations.push({
          type: 'amazon',
          url: null,
          data: { query: data.query, region: data.region },
          weight: conf,
        });
      }
      if (sharedGtin) {
        rows.push({ field: 'gtin', source: weightKey, value: sharedGtin, confidence: conf });
      }
      break;
    }

    default:
      break;
  }

  return { rows, citations };
}

// ---------------------------------------------------------------------------
// Safe executor wrapper — never throws, always returns a result-shape.
// ---------------------------------------------------------------------------

async function safeExecute(executor, args, name, toolsCalled) {
  if (typeof executor !== 'function') {
    return {
      ok: false,
      source: name,
      data: null,
      confidence: 0,
      meta: { durationMs: 0 },
      error: { code: 'EXECUTOR_MISSING', message: `no executor for ${name}` },
    };
  }
  const started = Date.now();
  try {
    const res = await executor(args);
    toolsCalled.push({ name, ok: Boolean(res?.ok), durationMs: Date.now() - started });
    return res;
  } catch (err) {
    toolsCalled.push({ name, ok: false, durationMs: Date.now() - started });
    return {
      ok: false,
      source: name,
      data: null,
      confidence: 0,
      meta: { durationMs: Date.now() - started },
      error: { code: 'EXECUTOR_THREW', message: err?.message || String(err) },
    };
  }
}

// ---------------------------------------------------------------------------
// Gemini fallback agentic loop — only runs when aiClient is injected.
// ---------------------------------------------------------------------------

async function runGeminiFallback({
  context,
  toolsCalled,
  geminiCallCounter,
  tokensAccumulator,
}) {
  const aiClient = context && context.aiClient;
  if (!aiClient || !aiClient.chats || typeof aiClient.chats.create !== 'function') {
    return { rows: [], citations: [], finalized: null };
  }

  const model = resolveChatModel();
  const executorMap = atomicTools.buildToolExecutorMap();
  const identity = context.identity || {};
  const hints = [
    identity.brand ? `brand: ${identity.brand}` : null,
    identity.model ? `model: ${identity.model}` : null,
    identity.name ? `name: ${identity.name}` : null,
    context.hint ? `hint: ${context.hint}` : null,
  ].filter(Boolean);

  const tools = [
    {
      functionDeclarations: [
        atomicTools.declarations.lookupGtin,
        atomicTools.declarations.verifyBrand,
        atomicTools.declarations.searchAmazonProduct,
        FINALIZE_IDENTITY_DECLARATION,
      ],
    },
  ];

  const config = {
    temperature: DEFAULT_CHAT_TEMPERATURE,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    thinkingConfig: defaultThinkingConfig({ level: 'high', includeThoughts: false }),
    safetySettings: defaultSafetySettings(),
    tools,
    toolConfig: {
      functionCallingConfig: { mode: 'AUTO' },
      includeServerSideToolInvocations: true,
    },
    systemInstruction: SYSTEM_PROMPT,
  };

  let chat;
  try {
    chat = aiClient.chats.create({ model, config, history: [] });
  } catch (err) {
    return {
      rows: [],
      citations: [],
      finalized: null,
      error: `chats.create failed: ${err?.message || err}`,
    };
  }

  const initialMessage = [
    'Produkt-Identity ermitteln.',
    hints.length ? `Hinweise: ${hints.join(', ')}` : 'Keine strukturierten Hinweise vorhanden.',
    'Rufe atomic tools, um GTIN/Brand/MPN zu finden. Finalisiere mit finalize_identity.',
  ].join('\n');

  let response;
  try {
    geminiCallCounter.count += 1;
    response = await chat.sendMessage({ message: [{ text: initialMessage }] });
    if (response?.usageMetadata?.totalTokenCount) {
      tokensAccumulator.total += response.usageMetadata.totalTokenCount;
    }
  } catch (err) {
    return {
      rows: [],
      citations: [],
      finalized: null,
      error: `sendMessage failed: ${err?.message || err}`,
    };
  }

  const evidence = { rows: [], citations: [] };
  let finalized = null;
  let iteration = 0;

  while (
    response &&
    Array.isArray(response.functionCalls) &&
    response.functionCalls.length > 0 &&
    iteration < MAX_WORKER_ITERATIONS
  ) {
    iteration += 1;
    const toolResponses = [];
    for (const call of response.functionCalls) {
      const callName = call?.name || 'unknown';
      const callArgs = call?.args || {};
      const callId = call?.id || null;

      if (callName === FINALIZE_TOOL) {
        finalized = callArgs || {};
        toolResponses.push({
          functionResponse: {
            id: callId || undefined,
            name: callName,
            response: { ok: true, accepted: true },
          },
        });
        continue;
      }

      const executor = executorMap[callName];
      // eslint-disable-next-line no-await-in-loop
      const result = await safeExecute(executor, callArgs, callName, toolsCalled);
      if (result?.ok) {
        const ev = evidenceFromToolResult(result, callArgs?.gtin || null);
        for (const r of ev.rows) evidence.rows.push(r);
        for (const c of ev.citations) evidence.citations.push(c);
      }
      toolResponses.push({
        functionResponse: {
          id: callId || undefined,
          name: callName,
          response: result,
        },
      });
    }

    if (finalized) break;

    // Forced finalization on the last allowed iteration.
    const atLastIter = iteration >= MAX_WORKER_ITERATIONS - 1;
    const sendConfig = atLastIter
      ? {
          toolConfig: {
            functionCallingConfig: {
              mode: FunctionCallingConfigMode.ANY,
              allowedFunctionNames: [FINALIZE_TOOL],
            },
          },
        }
      : undefined;

    try {
      geminiCallCounter.count += 1;
      // eslint-disable-next-line no-await-in-loop
      response = await (sendConfig
        ? chat.sendMessage({ message: toolResponses, config: sendConfig })
        : chat.sendMessage({ message: toolResponses }));
      if (response?.usageMetadata?.totalTokenCount) {
        tokensAccumulator.total += response.usageMetadata.totalTokenCount;
      }
    } catch (err) {
      return {
        rows: evidence.rows,
        citations: evidence.citations,
        finalized,
        error: `sendMessage iter ${iteration} failed: ${err?.message || err}`,
      };
    }
  }

  return {
    rows: evidence.rows,
    citations: evidence.citations,
    finalized,
  };
}

// ---------------------------------------------------------------------------
// Main worker entry point
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   product?: object,
 *   files?: Array,
 *   imageParts?: Array,
 *   identity?: { brand?: string, model?: string, name?: string },
 *   barcodes?: string|Array,
 *   ocrPayload?: { text?: string },
 *   locale?: string,
 *   hint?: string,
 *   workerResults?: object,
 *   iteration?: number,
 *   additionalSources?: Array,
 *   aiClient?: object
 * }} context
 */
async function runIdentityWorker(context = {}) {
  const startedAt = Date.now();
  const toolsCalled = [];
  const geminiCallCounter = { count: 0 };
  const tokensAccumulator = { total: 0 };
  const sources = [];
  let lastError = null;

  // Safety: never throw. Wrap the entire body.
  try {
    const executorMap = atomicTools.buildToolExecutorMap();
    const validGtins = collectValidGtins(context);
    const primaryGtin = pickPrimaryGtin(validGtins);
    const identity = context.identity || {};

    const evidenceRows = [];
    const citations = [];

    // ---- Path A: GTIN available → atomic-tools parallel ---------------------
    if (primaryGtin) {
      const results = await Promise.all([
        safeExecute(
          executorMap.lookup_gtin,
          { gtin: primaryGtin, locale: context.locale || 'de-DE' },
          'lookup_gtin',
          toolsCalled
        ),
        identity.brand
          ? safeExecute(
              executorMap.verify_brand,
              { brand: identity.brand, mpn: identity.mpn || undefined },
              'verify_brand',
              toolsCalled
            )
          : Promise.resolve(null),
        safeExecute(
          executorMap.search_amazon_product,
          {
            gtin: primaryGtin,
            query: identity.brand && identity.model
              ? `${identity.brand} ${identity.model}`
              : undefined,
            region: (context.locale || '').toLowerCase().startsWith('de') ? 'DE' : 'DE',
          },
          'search_amazon_product',
          toolsCalled
        ),
      ]);

      for (const res of results) {
        if (!res) continue;
        if (res.ok) {
          sources.push({
            type: res.source,
            url: res.data?.url || res.data?.result?.url || null,
            data: res.data,
            weight: typeof res.confidence === 'number' ? res.confidence : 0.5,
          });
          const ev = evidenceFromToolResult(res, primaryGtin);
          for (const row of ev.rows) evidenceRows.push(row);
          for (const c of ev.citations) citations.push(c);
        }
      }

      // GTIN itself corroborated by mod-10 checksum validity.
      evidenceRows.push({
        field: 'gtin',
        source: 'ocr',
        value: primaryGtin,
        confidence: 0.65,
      });
    } else {
      // ---- Path B: Gemini fallback (only if aiClient present) ---------------
      const fallback = await runGeminiFallback({
        context,
        toolsCalled,
        geminiCallCounter,
        tokensAccumulator,
      });
      if (fallback.error) lastError = fallback.error;

      for (const row of fallback.rows) evidenceRows.push(row);
      for (const c of fallback.citations) citations.push(c);

      // Add finalized values from Gemini as its own evidence source.
      if (fallback.finalized && typeof fallback.finalized === 'object') {
        const f = fallback.finalized;
        const conf =
          typeof f.confidence === 'number' && Number.isFinite(f.confidence)
            ? Math.max(0, Math.min(1, f.confidence))
            : 0.5;
        if (f.brand) {
          evidenceRows.push({
            field: 'brand',
            source: 'gemini_inference',
            value: stripCorporateSuffix(f.brand),
            confidence: conf,
          });
        }
        if (f.mpn) {
          evidenceRows.push({
            field: 'mpn',
            source: 'gemini_inference',
            value: f.mpn,
            confidence: conf,
          });
        }
        const fg = normalizeDigits(String(f.gtin || f.ean || f.upc || ''));
        if (fg && isValidGtin(fg)) {
          evidenceRows.push({
            field: 'gtin',
            source: 'gemini_inference',
            value: fg,
            confidence: conf,
          });
        }
      }
    }

    // ---- Brand preservation from context when atomic tools silent ----------
    const hasBrandEvidence = evidenceRows.some((r) => r.field === 'brand');
    if (!hasBrandEvidence && identity.brand) {
      evidenceRows.push({
        field: 'brand',
        source: 'user_input',
        value: stripCorporateSuffix(identity.brand),
        confidence: 0.7,
      });
    }
    if (identity.mpn && !evidenceRows.some((r) => r.field === 'mpn')) {
      evidenceRows.push({
        field: 'mpn',
        source: 'user_input',
        value: identity.mpn,
        confidence: 0.7,
      });
    }

    // ---- Consensus per field + score --------------------------------------
    const fields = ['gtin', 'ean', 'upc', 'brand', 'mpn'];
    const resolved = {};
    const confidence = {};

    for (const field of fields) {
      const candidates = evidenceRows
        .filter((r) => r.field === field || (field === 'gtin' && (r.field === 'ean' || r.field === 'upc')))
        .map((r) => ({ source: r.source, value: r.value, confidence: r.confidence }));

      if (!candidates.length) continue;

      const consensus = resolveConsensus(field, candidates);
      if (consensus.value == null) continue;

      // For GTIN/EAN/UPC: mirror the value into the matching length-specific
      // slot when appropriate.
      resolved[field] = consensus.value;
      if (field === 'gtin') {
        const digits = normalizeDigits(String(consensus.value));
        if (digits.length === 13) resolved.ean = digits;
        if (digits.length === 12) resolved.upc = digits;
      }

      const evidenceForScore = candidates.map((c) => ({ source: c.source, value: c.value }));
      const scored = scoreField(field, consensus.value, evidenceForScore);
      confidence[field] = scored.score;
      if (field === 'gtin' && resolved.ean) confidence.ean = scored.score;
      if (field === 'gtin' && resolved.upc) confidence.upc = scored.score;
    }

    const durationMs = Date.now() - startedAt;
    const ok = Object.keys(resolved).length > 0 || !lastError;

    return {
      ok,
      domain: DOMAIN,
      resolved,
      confidence,
      sources,
      retriesRequested: [],
      meta: {
        durationMs,
        tokensUsed: tokensAccumulator.total,
        toolsCalled,
        geminiCalls: geminiCallCounter.count,
        error: lastError,
      },
    };
  } catch (err) {
    return {
      ok: false,
      domain: DOMAIN,
      resolved: {},
      confidence: {},
      sources,
      retriesRequested: [],
      meta: {
        durationMs: Date.now() - startedAt,
        tokensUsed: tokensAccumulator.total,
        toolsCalled,
        geminiCalls: geminiCallCounter.count,
        error: err?.message || String(err),
      },
    };
  }
}

module.exports = {
  runIdentityWorker,
  DOMAIN,
  FINALIZE_IDENTITY_DECLARATION,
  SYSTEM_PROMPT,
  _testables: {
    collectValidGtins,
    extractCandidatesFromBarcodes,
    extractCandidatesFromText,
    pickPrimaryGtin,
    evidenceFromToolResult,
    stripCorporateSuffix,
    mapToolSourceWeight,
    MAX_WORKER_ITERATIONS,
  },
};
