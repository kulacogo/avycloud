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

const SMALL_MODELS_ALLOWED = process.env.ALLOW_GPT5_SMALL === 'true';

function isSmallModel(model) {
  return model === 'gpt-5-mini' || model === 'gpt-5-nano';
}

function normalize(input) {
  return typeof input === 'string' ? input.trim().toLowerCase() : '';
}

function normalizeModel(input) {
  const normalized = normalize(input);
  if (!normalized || normalized === 'default' || normalized === 'auto') {
    return null;
  }
  if (MODEL_MAP[normalized]) {
    return MODEL_MAP[normalized];
  }
  if (input && input.startsWith('gpt-5')) {
    return input;
  }
  return null;
}

function enforceAvailability(model, fallback) {
  if (!model) return fallback;
  if (!SMALL_MODELS_ALLOWED && isSmallModel(model)) {
    return fallback;
  }
  return model;
}

function resolveModel(preferred, envKey, fallback = 'gpt-5.1') {
  const absoluteFallback = fallback || 'gpt-5.1';
  const envRaw = process.env[envKey];
  const preferredModel = normalizeModel(preferred);
  const envModel = normalizeModel(envRaw);
  const chain = [preferredModel, envModel, normalizeModel(absoluteFallback), 'gpt-5.1'];

  for (const candidate of chain) {
    const enforced = enforceAvailability(candidate, null);
    if (enforced) {
      return enforced;
    }
  }

  return 'gpt-5.1';
}

module.exports = {
  resolveModel,
};

