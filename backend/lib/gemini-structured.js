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
  temperature = 0.2,
  topP = 0.8,
  topK = 40,
  maxOutputTokens = 1024,
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
      responseMimeType: 'application/json',
      responseSchema,
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
  const primaryText = partsResponse.find((p) => typeof p?.text === 'string')?.text || '';
  const textPayload = (primaryText || '').trim();
  if (!textPayload) {
    throw new Error('Gemini structured call returned empty payload.');
  }
  return textPayload;
}

module.exports = {
  callGeminiStructured,
};

