const ALLOWED_MODELS = new Set([
  // Gemini 3.1 (current preview, see: https://ai.google.dev/gemini-api/docs/models)
  'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools',
  'gemini-3.1-flash-lite',
  // Gemini 3 (still accepted — deprecated endpoints route to 3.1 server-side)
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
  // All aliases now default to the Gemini 3.1 Pro customtools variant
  // (same price as gemini-3.1-pro-preview, but stabler function calling).
  // Lightweight tasks use gemini-3-flash-preview.
  mini: 'gemini-3-flash-preview',
  nano: 'gemini-3-flash-preview',
  standard: 'gemini-3.1-pro-preview-customtools',
  default: 'gemini-3.1-pro-preview-customtools',
  thinking: 'gemini-3.1-pro-preview-customtools',
  // Common aliases
  flash: 'gemini-3-flash-preview',
  pro: 'gemini-3.1-pro-preview-customtools',
  'gemini-flash': 'gemini-3-flash-preview',
  'gemini-thinking': 'gemini-3.1-pro-preview-customtools',
  'gemini-pro': 'gemini-3.1-pro-preview-customtools',
  'gemini-3-pro': 'gemini-3.1-pro-preview-customtools',
  'gemini-3-flash': 'gemini-3-flash-preview',
  // Legacy 3.0 preview alias — upstream deprecated 2026-03-26, route to 3.1 customtools
  'gemini-3-pro-preview': 'gemini-3.1-pro-preview-customtools',
  // Legacy 2.5 aliases — still resolve but to Gemini 3.1
  'gemini-2.5-flash': 'gemini-3-flash-preview',
  'gemini-2.5-pro': 'gemini-3.1-pro-preview-customtools',
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

function resolveModel(preferred, envKey, fallback = 'gemini-3.1-pro-preview-customtools') {
  const absoluteFallback = fallback || 'gemini-3.1-pro-preview-customtools';
  const envRaw = process.env[envKey];
  const chain = [preferred, envRaw, absoluteFallback, 'gemini-3.1-pro-preview-customtools'];

  for (const candidate of chain) {
    const normalized = normalizeModel(candidate);
    if (normalized && ALLOWED_MODELS.has(normalized)) {
      return normalized;
    }
  }

  return 'gemini-3.1-pro-preview-customtools';
}

module.exports = {
  resolveModel,
};

