const ALLOWED_MODELS = new Set([
  'gemini-2.5-flash',
  'gemini-2.0-flash-exp',
  'gemini-2.0-flash-thinking-exp',
  'gemini-exp-1206',
  'gemini-1.5-pro-002',
]);

const MODEL_ALIASES = {
  mini: 'gemini-2.5-flash',
  nano: 'gemini-2.5-flash',
  standard: 'gemini-2.5-flash',
  thinking: 'gemini-2.5-flash', // mapping thinking to flash per strict user request
  default: 'gemini-2.5-flash',
  'gemini-flash': 'gemini-2.5-flash',
  'gemini-thinking': 'gemini-2.5-flash',
  'gemini-pro': 'gemini-2.5-flash',
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

