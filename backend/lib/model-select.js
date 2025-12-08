const ALLOWED_MODELS = new Set([
  'gemini-2.0-flash-exp',
  'gemini-2.0-flash-thinking-exp',
  'gemini-2.5-flash-exp',
  'gemini-2.5-flash-thinking-exp',
  'gemini-3.0-flash-exp',
  'gemini-exp-1206',
]);

const MODEL_ALIASES = {
  mini: 'gemini-2.0-flash-exp',
  nano: 'gemini-2.0-flash-exp',
  standard: 'gemini-exp-1206',
  thinking: 'gemini-2.0-flash-thinking-exp',
  default: 'gemini-2.0-flash-exp',
  'gemini-flash': 'gemini-2.0-flash-exp',
  'gemini-thinking': 'gemini-2.0-flash-thinking-exp',
  'gemini-pro': 'gemini-exp-1206',
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
  if (input && ALLOWED_MODELS.has(input)) {
    return input;
  }
  return null;
}

function resolveModel(preferred, envKey, fallback = 'gemini-2.0-flash-exp') {
  const absoluteFallback = fallback || 'gemini-2.0-flash-exp';
  const envRaw = process.env[envKey];
  const chain = [preferred, envRaw, absoluteFallback, 'gemini-2.0-flash-exp'];

  for (const candidate of chain) {
    const normalized = normalizeModel(candidate);
    if (normalized && ALLOWED_MODELS.has(normalized)) {
      return normalized;
    }
  }

  return 'gemini-2.0-flash-exp';
}

module.exports = {
  resolveModel,
};

