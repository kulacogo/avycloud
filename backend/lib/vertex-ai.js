const GEMINI_API_KEY = process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY;
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

function buildEndpoint(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

function extractBase64Payload(dataUrl = '') {
  if (!dataUrl) return null;
  const dataUrlMatch = dataUrl.match(/^data:(?<mime>[^;]+);base64,(?<data>.+)$/);
  if (dataUrlMatch?.groups?.data) {
    return {
      mimeType: dataUrlMatch.groups.mime || 'image/png',
      data: dataUrlMatch.groups.data,
    };
  }
  // Assume plain base64 when string looks like it (no schema, mostly base64 chars)
  const stripped = dataUrl.trim();
  if (/^[a-z0-9+/]+=*$/i.test(stripped)) {
    return { mimeType: null, data: stripped };
  }
  return null;
}

function ensureGeminiConfig() {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY (or GOOGLE_GENAI_API_KEY) is not configured');
  }
}

function normalizeInlineData(part = {}) {
  const inline = part.inlineData || part.inline_data;
  if (!inline?.data) return null;
  return {
    base64: inline.data,
    mimeType: inline.mimeType || inline.mime_type || 'image/png',
  };
}

async function callGeminiGenerateContent({ parts, aspectRatio, model, timeoutMs }) {
  ensureGeminiConfig();
  const params = new URLSearchParams({ key: GEMINI_API_KEY });
  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
    },
  };

  if (aspectRatio) {
    body.generationConfig.imageConfig = { aspectRatio };
  }

  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetch(`${buildEndpoint(model || GEMINI_IMAGE_MODEL)}?${params.toString()}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!response.ok) {
    const errorText = await response.text();
    let reason = errorText;
    try {
      const parsed = JSON.parse(errorText);
      reason = parsed.error?.message || JSON.stringify(parsed.error) || reason;
    } catch (err) {
      // ignore JSON parse issues
    }
    throw new Error(`Gemini image API failed (${response.status}): ${reason}`);
  }

  const data = await response.json();
  if (!Array.isArray(data?.candidates)) {
    throw new Error('Gemini image API returned no candidates');
  }

  const images = [];
  for (const candidate of data.candidates) {
    const candidateParts = candidate?.content?.parts || [];
    for (const part of candidateParts) {
      const normalized = normalizeInlineData(part);
      if (normalized) {
        images.push(normalized);
      }
    }
  }
  return images;
}

async function generateProductImages({
  prompt,
  count = 1,
  aspectRatio = '1:1',
  referenceImageBase64 = null,
  model = null,
  timeoutMs = 0,
}) {
  if (!prompt?.trim()) {
    throw new Error('Prompt is required for Gemini image generation');
  }

  const parts = [];
  if (referenceImageBase64) {
    const payload = extractBase64Payload(referenceImageBase64);
    if (!payload?.data) {
      throw new Error('Invalid reference image payload provided');
    }
    parts.push({
      inline_data: {
        mime_type: payload.mimeType || 'image/png',
        data: payload.data,
      },
    });
  }

  parts.push({ text: prompt.trim() });

  const results = [];
  while (results.length < count) {
    const batch = await callGeminiGenerateContent({ parts, aspectRatio, model, timeoutMs });
    if (!batch.length) {
      break;
    }
    results.push(...batch);
  }

  return results.slice(0, count);
}

module.exports = {
  generateProductImages,
};
