const ALLOWED_MODELS = new Set([
  'gpt-5-mini-2025-08-07',
  'gpt-5-mini',
  'gpt-5.1',
  'gpt-4.1-mini',
  'gpt-4.1',
  'gemini-2.0-flash-exp',
  'gemini-2.0-flash-thinking-exp',
  'gemini-2.5-flash-exp',
  'gemini-2.5-flash-thinking-exp',
  'gemini-3.0-flash-exp',
  'gemini-exp-1206',
]);

const MODEL_ALIASES = {
  mini: 'gemini-2.5-flash-exp',
  nano: 'gemini-2.5-flash-exp',
  standard: 'gemini-3.0-flash-exp',
  thinking: 'gemini-2.5-flash-thinking-exp',
  default: null,
  'gpt-5-mini': 'gpt-5-mini',
  'gpt-5-mini-2025-08-07': 'gpt-5-mini-2025-08-07',
  'gpt-5.1': 'gpt-5.1',
  'gpt-5.1-mini': 'gpt-5-mini-2025-08-07',
  'gpt-5.1-nano': 'gpt-5-mini',
  'gpt-4.1-mini': 'gpt-4.1-mini',
  'gpt-4.1': 'gpt-4.1',
  'gemini-flash': 'gemini-2.5-flash-exp',
  'gemini-thinking': 'gemini-2.5-flash-thinking-exp',
  'gemini-pro': 'gemini-3.0-flash-exp',
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

function resolveModel(preferred, envKey, fallback = 'gpt-5-mini-2025-08-07') {
  const absoluteFallback = fallback || 'gpt-5-mini-2025-08-07';
  const envRaw = process.env[envKey];
  const chain = [preferred, envRaw, absoluteFallback, 'gpt-5-mini'];

  for (const candidate of chain) {
    const normalized = normalizeModel(candidate);
    if (normalized && ALLOWED_MODELS.has(normalized)) {
      return normalized;
    }
  }

  return 'gpt-5-mini-2025-08-07';
}

module.exports = {
  resolveModel,
};

