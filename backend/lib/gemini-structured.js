const { getGeminiClient } = require('./gemini-client');
const { HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { resolveModel } = require('./model-select');
const { callGeminiWithRetry } = require('./gemini-retry');
const logger = require('./logger');
const { getSchemaForScope, isStrictMode, validateRate } = require('./llm-schemas/_index');

/**
 * Phase F.3 — 2-stufige zod-Schema-Validation (mirrors gemini3-client).
 *
 * Stufe 1 (default): safeParse + warn — returns the unmodified textPayload.
 * Stufe 2 (LLM_SCHEMA_STRICT=true): parse + throw with clear error.
 */
function _resolveScopeName(scopeConfig) {
  if (!scopeConfig || typeof scopeConfig !== 'object') return null;
  const hint = scopeConfig.outputSchemaHint;
  if (typeof hint === 'string' && hint.trim() && !hint.trim().startsWith('{') && !hint.trim().startsWith('[')) {
    return hint.trim();
  }
  if (typeof scopeConfig.scopeId === 'string' && scopeConfig.scopeId.trim()) {
    return scopeConfig.scopeId.trim();
  }
  return null;
}

function _summarizeZodIssues(issues) {
  if (!Array.isArray(issues)) return [];
  return issues.slice(0, 10).map((iss) => ({
    path: Array.isArray(iss.path) ? iss.path.join('.') : String(iss.path || ''),
    code: iss.code,
    message: iss.message,
  }));
}

function _validateTextPayload(textPayload, scopeConfig) {
  const scopeName = _resolveScopeName(scopeConfig);
  if (!scopeName) return textPayload;
  const schema = getSchemaForScope(scopeName);
  if (!schema) return textPayload;

  let parsed;
  try {
    parsed = JSON.parse(textPayload);
  } catch (_) {
    // Caller will hit the parse error themselves — do not double-throw here.
    return textPayload;
  }

  const strict = isStrictMode();
  if (strict) {
    try {
      schema.parse(parsed);
    } catch (err) {
      const summary = _summarizeZodIssues(err && err.issues);
      const e = new Error(
        `llm-schemas: strict validation failed for scope='${scopeName}'. issues=${JSON.stringify(summary)}`
      );
      e.code = 'LLM_SCHEMA_VALIDATION_FAILED';
      e.scope = scopeName;
      e.issues = summary;
      throw e;
    }
    return textPayload;
  }

  const rate = validateRate();
  const shouldLog = rate >= 1.0 || Math.random() < rate;
  if (!shouldLog) return textPayload;
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const summary = _summarizeZodIssues(result.error && result.error.issues);
    try {
      logger.warn(
        { scope: scopeName, issues: summary, mode: 'safeparse' },
        '[llm-schemas] safeParse mismatch — Stufe 1 (non-throwing)'
      );
    } catch (_) { /* logger unavailable in some test setups */ }
  }
  return textPayload;
}

// Permissive safety settings — product images from warehouses should never be blocked
const PERMISSIVE_SAFETY = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

// Resolve at call-time so env changes & alias updates are picked up;
// resolveModel() ensures deprecated `gemini-3-pro-preview` is auto-aliased
// to the supported preview model (see lib/model-select.js).
function getStructuredModelName() {
  return resolveModel(
    process.env.GEMINI_MULTIMODAL_MODEL,
    'GEMINI_STRUCTURED_MODEL',
    'gemini-2.5-pro'
  );
}

// Keep the schema compatible with Gemini responseSchema constrained decoding.
// Inspired by the (working) legacy identify pipeline in backend/services/enrichment.js.
function cleanSchemaForGemini(schema = {}) {
  if (!schema || typeof schema !== 'object') return schema;
  const cleaned = Array.isArray(schema) ? schema.map(cleanSchemaForGemini) : { ...schema };

  // Fix type arrays: type: ["string", "null"] -> type: "string"
  if (Array.isArray(cleaned.type)) {
    const validTypes = cleaned.type.filter((t) => t !== 'null');
    cleaned.type = validTypes.length === 1 ? validTypes[0] : validTypes[0] || 'string';
  }

  if (cleaned.properties) {
    const next = {};
    for (const [key, val] of Object.entries(cleaned.properties)) {
      next[key] = cleanSchemaForGemini(val);
    }
    cleaned.properties = next;
  }
  if (cleaned.items) {
    cleaned.items = cleanSchemaForGemini(cleaned.items);
  }

  // Remove keys Gemini rejects/ignores in strict schemas
  delete cleaned.additionalProperties;
  delete cleaned.default;
  delete cleaned.anyOf;

  return cleaned;
}

function toSdkParts(parts = []) {
  if (!Array.isArray(parts)) return [];
  return parts
    .map((part) => {
      if (!part) return null;
      // REST format -> SDK format
      if (part.inline_data?.data) {
        return {
          inlineData: {
            data: String(part.inline_data.data),
            mimeType: String(part.inline_data.mime_type || 'application/octet-stream'),
          },
        };
      }
      if (typeof part.text === 'string') {
        return { text: part.text };
      }
      return null;
    })
    .filter(Boolean);
}

async function callGeminiStructured(opts = {}) {
  const {
    parts,
    responseSchema,
    temperature,
    topP,
    topK,
    maxOutputTokens,
    candidateCount,
    stopSequences,
    scopeConfig, // Phase F.1b — optional resolveScopeConfig result
  } = opts;

  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('Structured Gemini call requires at least one part (text or inline_data).');
  }

  const client = await getGeminiClient();

  // Phase F.1b: scopeConfig.model wins over the env-resolved default if provided.
  const scopeModel =
    scopeConfig && typeof scopeConfig === 'object' && typeof scopeConfig.model === 'string' && scopeConfig.model.trim()
      ? scopeConfig.model.trim()
      : null;
  const modelName = scopeModel ? resolveModel(scopeModel, 'GEMINI_STRUCTURED_MODEL', getStructuredModelName()) : getStructuredModelName();
  console.log('[gemini-structured] model=' + modelName);
  const model = client.getGenerativeModel({ model: modelName });

  // Phase F.1b: merge helper-internal defaults < scopeConfig.generationConfig < explicit caller-overrides.
  const helperDefaults = {
    temperature: 0.0,
    topP: 0.8,
    topK: 40,
    maxOutputTokens: 1024,
    candidateCount: 1,
  };
  const callerOverrides = {};
  if (Object.prototype.hasOwnProperty.call(opts, 'temperature') && temperature !== undefined) callerOverrides.temperature = temperature;
  if (Object.prototype.hasOwnProperty.call(opts, 'topP') && topP !== undefined) callerOverrides.topP = topP;
  if (Object.prototype.hasOwnProperty.call(opts, 'topK') && topK !== undefined) callerOverrides.topK = topK;
  if (Object.prototype.hasOwnProperty.call(opts, 'maxOutputTokens') && maxOutputTokens !== undefined) callerOverrides.maxOutputTokens = maxOutputTokens;
  if (Object.prototype.hasOwnProperty.call(opts, 'candidateCount') && candidateCount !== undefined) callerOverrides.candidateCount = candidateCount;

  const scopeGenCfg =
    scopeConfig && typeof scopeConfig === 'object' && scopeConfig.generationConfig && typeof scopeConfig.generationConfig === 'object'
      ? scopeConfig.generationConfig
      : null;

  const merged = { ...helperDefaults };
  if (scopeGenCfg) Object.assign(merged, scopeGenCfg);
  Object.assign(merged, callerOverrides);

  const generationConfig = {
    ...merged,
    responseMimeType: 'application/json',
    // SDK uses responseSchema (constrained decoding); this is the same approach as the legacy pipeline.
    responseSchema: cleanSchemaForGemini(responseSchema),
  };

  // stopSequences: explicit caller wins; else scopeConfig.generationConfig.stopSequences (if present); else default ['```'].
  let effectiveStopSequences;
  if (Object.prototype.hasOwnProperty.call(opts, 'stopSequences')) {
    effectiveStopSequences = stopSequences;
  } else if (scopeGenCfg && Array.isArray(scopeGenCfg.stopSequences)) {
    effectiveStopSequences = scopeGenCfg.stopSequences;
  } else {
    effectiveStopSequences = ['```'];
  }
  if (Array.isArray(effectiveStopSequences) && effectiveStopSequences.length > 0) {
    generationConfig.stopSequences = effectiveStopSequences;
  } else {
    // Make sure we don't carry over a scope-level stopSequences as a non-array.
    delete generationConfig.stopSequences;
  }

  const sdkParts = toSdkParts(parts);
  // Wrap only the network call in retry — empty-payload / blocked-prompt errors
  // are deterministic and must NOT be retried (see callGeminiWithRetry guards).
  const result = await callGeminiWithRetry(
    () => model.generateContent({
      contents: [{ role: 'user', parts: sdkParts }],
      generationConfig,
      safetySettings: PERMISSIVE_SAFETY,
    }),
    { maxRetries: 2, delayMs: 1500 }
  );

  // IMPORTANT:
  // @google/generative-ai can return multiple content parts. Some deployments have shown
  // response.text() not containing the full concatenation for structured JSON use-cases.
  // We therefore concatenate parts manually (without inserting separators).
  const resp = result?.response;

  // Diagnose blocked / empty responses
  const promptFeedback = resp?.promptFeedback;
  if (promptFeedback?.blockReason) {
    console.error(`[gemini-structured] Prompt BLOCKED: reason=${promptFeedback.blockReason}`, JSON.stringify(promptFeedback));
    throw new Error(`Gemini blocked the prompt: ${promptFeedback.blockReason}`);
  }

  const candidates = Array.isArray(resp?.candidates) ? resp.candidates : [];
  const finishReason = candidates[0]?.finishReason;
  if (finishReason === 'MAX_TOKENS') {
    console.warn(`[gemini-structured] Response truncated (MAX_TOKENS) — output may be incomplete JSON. Consider increasing maxOutputTokens.`);
  } else if (finishReason && finishReason !== 'STOP') {
    console.warn(`[gemini-structured] Unexpected finishReason: ${finishReason}`, JSON.stringify(candidates[0]?.safetyRatings || []));
  }

  const partsResponse = candidates[0]?.content?.parts || [];
  const textParts = Array.isArray(partsResponse)
    ? partsResponse
        .map((p) => (typeof p?.text === 'string' ? p.text : ''))
        .filter((t) => t && t.trim().length > 0)
    : [];
  let textPayload = textParts.join('').trim();
  if (!textPayload) {
    const diagInfo = {
      candidateCount: candidates.length,
      finishReason,
      hasParts: partsResponse.length,
      promptFeedback: promptFeedback || null,
    };
    console.error('[gemini-structured] Empty payload. Diagnostics:', JSON.stringify(diagInfo));
    throw new Error(`Gemini structured call returned empty payload. finishReason=${finishReason || 'none'}, candidates=${candidates.length}`);
  }

  // Strip markdown code fences if Gemini wraps JSON in ```json ... ```
  if (textPayload.startsWith('```')) {
    textPayload = textPayload.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  // Strip leading non-JSON text (e.g. "Here is the JSON requested:\n")
  const jsonStart = textPayload.indexOf('{');
  if (jsonStart > 0 && jsonStart < 200) {
    textPayload = textPayload.slice(jsonStart).trim();
  }

  // Phase F.3 — 2-stufige zod-Schema-Validation (safeParse Stufe 1 default).
  return _validateTextPayload(textPayload, scopeConfig);
}

module.exports = {
  callGeminiStructured,
  getStructuredModelName,
  // Phase F.3 — exposed for unit tests.
  __validateTextPayload: _validateTextPayload,
  __resolveScopeName: _resolveScopeName,
};

