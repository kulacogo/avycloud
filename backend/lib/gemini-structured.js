const GEMINI_API_KEY = process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY;
const GEMINI_MULTIMODAL_MODEL =
  process.env.GEMINI_MULTIMODAL_MODEL ||
  process.env.GEMINI_STRUCTURED_MODEL ||
  'gemini-2.5-flash';

const BASE_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MULTIMODAL_MODEL}:generateContent`;

function ensureConfig() {
  if (!GEMINI_API_KEY) {
    throw new Error(
      'GEMINI_API_KEY (or GOOGLE_GENAI_API_KEY) must be configured for multimodal structured generation.'
    );
  }
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
  ensureConfig();
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('Structured Gemini call requires at least one part (text or inline_data).');
  }

  const body = {
    contents: [
      {
        role: 'user',
        parts,
      },
    ],
    generationConfig: {
      temperature,
      topP,
      topK,
      maxOutputTokens,
      candidateCount,
      stopSequences,
      responseMimeType: 'application/json',
      // Official REST field name (Gemini API structured output):
      // generationConfig.responseJsonSchema
      // https://ai.google.dev/gemini-api/docs/structured-output
      responseJsonSchema: responseSchema,
    },
  };

  const endpoint = `${BASE_ENDPOINT}?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let reason = errorText;
    try {
      const parsed = JSON.parse(errorText);
      reason = parsed.error?.message || JSON.stringify(parsed.error) || reason;
    } catch (err) {
      // fall back to raw
    }
    throw new Error(`Gemini structured call failed (${response.status}): ${reason}`);
  }

  const data = await response.json();
  const candidates = data?.candidates;
  if (!Array.isArray(candidates) || !candidates.length) {
    throw new Error('Gemini structured call returned no candidates.');
  }
  const partsResponse = candidates[0]?.content?.parts || [];
  const textParts = partsResponse
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .filter((t) => t && t.trim().length > 0);
  // IMPORTANT:
  // Gemini can split responses across multiple content parts. If we only take the first part,
  // we can end up with incomplete JSON (e.g. just "{"), causing parse failures downstream.
  // So we concatenate all non-empty text parts.
  const textPayload = textParts.join('\n').trim();
  if (!textPayload) {
    throw new Error('Gemini structured call returned empty payload.');
  }
  return textPayload;
}

module.exports = {
  callGeminiStructured,
};

