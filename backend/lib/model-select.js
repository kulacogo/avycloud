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

function resolveModel(preferred, envKey, fallback = 'gpt-5.1') {
  const envValue = process.env[envKey] || fallback;
  const normalized = normalize(preferred);
  if (!normalized || normalized === 'default' || normalized === 'auto') {
    return envValue;
  }

  if (MODEL_MAP[normalized]) {
    return MODEL_MAP[normalized];
  }

  // Allow callers to pass full model IDs like "gpt-5.1-mini"
  if (preferred && preferred.startsWith('gpt-5')) {
    return preferred;
  }

  return envValue;
}

module.exports = {
  resolveModel,
};

