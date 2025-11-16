const MODEL_MAP = {
  mini: 'gpt-5-mini',
  nano: 'gpt-5-nano',
  'gpt-5-mini': 'gpt-5-mini',
  'gpt-5-nano': 'gpt-5-nano',
  // legacy aliases previously used in the UI
  'gpt-5.1-mini': 'gpt-5-mini',
  'gpt-5.1-nano': 'gpt-5-nano',
  'gpt-5.1': 'gpt-5.1',
  standard: 'gpt-5.1',
  default: null,
};

function normalize(input) {
  return typeof input === 'string' ? input.trim().toLowerCase() : '';
}

function mapModel(input, fallback) {
  const normalized = normalize(input);
  if (!normalized) return fallback;
  if (normalized === 'default' || normalized === 'auto') {
    return fallback;
  }
  if (MODEL_MAP[normalized]) {
    return MODEL_MAP[normalized];
  }
  if (input && input.startsWith('gpt-5')) {
    return input;
  }
  return fallback;
}

function resolveModel(preferred, envKey, fallback = 'gpt-5.1') {
  const envRaw = process.env[envKey];
  const defaultModel = mapModel(envRaw, fallback);
  return mapModel(preferred, defaultModel);
}

module.exports = {
  resolveModel,
};

