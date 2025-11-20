const ALLOWED_MODELS = new Set(['gpt-5-mini-2025-08-07', 'gpt-5-mini']);

const MODEL_ALIASES = {
  mini: 'gpt-5-mini-2025-08-07',
  nano: 'gpt-5-mini',
  standard: 'gpt-5-mini-2025-08-07',
  default: null,
  'gpt-5-mini': 'gpt-5-mini',
  'gpt-5-mini-2025-08-07': 'gpt-5-mini-2025-08-07',
  'gpt-5.1': 'gpt-5-mini-2025-08-07',
  'gpt-5.1-mini': 'gpt-5-mini-2025-08-07',
  'gpt-5.1-nano': 'gpt-5-mini',
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

