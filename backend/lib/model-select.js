const ALLOWED_MODELS = new Set([
  // Gemini 3 (official model codes, see: https://ai.google.dev/gemini-api/docs/models)
  'gemini-3-pro-preview',
  'gemini-3-flash-preview',
  // Gemini 2.5 (stable)
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-2.0-flash-exp',
  'gemini-2.0-flash-thinking-exp',
  'gemini-exp-1206',
  'gemini-1.5-pro-002',
]);

const MODEL_ALIASES = {
  // Default to Gemini 3 Pro (preview) per user request.
  mini: 'gemini-3-pro-preview',
  nano: 'gemini-3-pro-preview',
  standard: 'gemini-3-pro-preview',
  thinking: 'gemini-3-pro-preview',
  default: 'gemini-3-pro-preview',
  // Common aliases
  'gemini-flash': 'gemini-3-flash-preview',
  'gemini-thinking': 'gemini-3-pro-preview',
  'gemini-pro': 'gemini-3-pro-preview',
  'gemini-3-pro': 'gemini-3-pro-preview',
  'gemini-3-flash': 'gemini-3-flash-preview',
};

function normalize(input) {
  return typeof input === 'string' ? input.trim().toLowerCase() : '';
}

function normalizeModel(input) {
  const normalized = normalize(input);
  if (!normalized || normalized === 'default' || normalized === 'auto') {
    return null;
  }
  if (MODEL_ALIASES[normalized]) {
    return MODEL_ALIASES[normalized];
  }
  if (normalized && ALLOWED_MODELS.has(normalized)) {
    return normalized;
  }
  return null;
}

function resolveModel(preferred, envKey, fallback = 'gemini-3-pro-preview') {
  const absoluteFallback = fallback || 'gemini-3-pro-preview';
  const envRaw = process.env[envKey];
  const chain = [preferred, envRaw, absoluteFallback, 'gemini-3-pro-preview'];

  for (const candidate of chain) {
    const normalized = normalizeModel(candidate);
    if (normalized && ALLOWED_MODELS.has(normalized)) {
      return normalized;
    }
  }

  return 'gemini-3-pro-preview';
}

module.exports = {
  resolveModel,
};

