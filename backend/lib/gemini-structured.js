const { getGeminiClient } = require('./gemini-client');
const { HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// Permissive safety settings — product images from warehouses should never be blocked
const PERMISSIVE_SAFETY = [
  { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
  { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
];

const GEMINI_MULTIMODAL_MODEL =
  process.env.GEMINI_MULTIMODAL_MODEL ||
  process.env.GEMINI_STRUCTURED_MODEL ||
  'gemini-3-pro-preview';

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

async function callGeminiStructured({
  parts,
  responseSchema,
  temperature = 0.0,
  topP = 0.8,
  topK = 40,
  maxOutputTokens = 1024,
  candidateCount = 1,
  stopSequences = ['```'],
}) {
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('Structured Gemini call requires at least one part (text or inline_data).');
  }

  const client = await getGeminiClient();
  const model = client.getGenerativeModel({ model: GEMINI_MULTIMODAL_MODEL });

  const generationConfig = {
    temperature,
    topP,
    topK,
    maxOutputTokens,
    candidateCount,
    responseMimeType: 'application/json',
    // SDK uses responseSchema (constrained decoding); this is the same approach as the legacy pipeline.
    responseSchema: cleanSchemaForGemini(responseSchema),
  };
  if (Array.isArray(stopSequences) && stopSequences.length > 0) {
    generationConfig.stopSequences = stopSequences;
  }

  const sdkParts = toSdkParts(parts);
  const result = await model.generateContent({
    contents: [{ role: 'user', parts: sdkParts }],
    generationConfig,
    safetySettings: PERMISSIVE_SAFETY,
  });

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
  if (finishReason && finishReason !== 'STOP' && finishReason !== 'MAX_TOKENS') {
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

  return textPayload;
}

module.exports = {
  callGeminiStructured,
};

