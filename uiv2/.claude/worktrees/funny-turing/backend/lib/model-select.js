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
  // IMPORTANT:
  // Preview models have more restrictive rate limits and can hard-fail with 429 in production.
  // We therefore default to a stable, high-throughput model.
  mini: 'gemini-2.5-flash',
  nano: 'gemini-2.5-flash',
  standard: 'gemini-2.5-flash',
  default: 'gemini-2.5-flash',
  thinking: 'gemini-2.5-pro',
  // Common aliases
  flash: 'gemini-2.5-flash',
  pro: 'gemini-2.5-pro',
  'gemini-flash': 'gemini-2.5-flash',
  'gemini-thinking': 'gemini-2.5-pro',
  'gemini-pro': 'gemini-2.5-pro',
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

function resolveModel(preferred, envKey, fallback = 'gemini-2.5-flash') {
  const absoluteFallback = fallback || 'gemini-2.5-flash';
  const envRaw = process.env[envKey];
  const chain = [preferred, envRaw, absoluteFallback, 'gemini-2.5-flash'];

  for (const candidate of chain) {
    const normalized = normalizeModel(candidate);
    if (normalized && ALLOWED_MODELS.has(normalized)) {
      return normalized;
    }
  }

  return 'gemini-2.5-flash';
}

module.exports = {
  resolveModel,
};

