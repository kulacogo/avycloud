const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getSecretValue } = require('./secret-values');

let cachedClient = null;
let cachedKey = null;
let cachedKeySource = null;

async function getGeminiApiKey() {
    if (cachedKey) return cachedKey;

    const directKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY;
    if (directKey) {
        cachedKey = directKey;
        cachedKeySource = process.env.GEMINI_API_KEY ? 'env:GEMINI_API_KEY' : 'env:GOOGLE_GENAI_API_KEY';
        return directKey;
    }

    // Support both secret names (legacy + current). Many deployments use GOOGLE_GENAI_API_KEY.
    const secret =
      (await getSecretValue('GEMINI_API_KEY')) ||
      (await getSecretValue('GOOGLE_GENAI_API_KEY'));
    if (!secret) {
        throw new Error(
          'Gemini API key is not configured. Set GEMINI_API_KEY or GOOGLE_GENAI_API_KEY (env var or Secret Manager secret).'
        );
    }

    cachedKey = secret;
    cachedKeySource = 'secret';
    return secret;
}

async function getGeminiClient() {
    if (cachedClient) return cachedClient;

    const apiKey = await getGeminiApiKey();
    cachedClient = new GoogleGenerativeAI(apiKey);
    return cachedClient;
}

const { resolveModel } = require('./model-select');
const { callGeminiWithRetry } = require('./gemini-retry');

/**
 * Send a text prompt + inline images to Gemini Vision.
 * @param {string} textPrompt
 * @param {Array<{buffer: Buffer, mimeType: string}>} imageBuffers
 * @param {object} [options]  May contain `scopeConfig` (Phase F.1b, optional
 *   resolveScopeConfig result) plus the legacy `temperature` / `maxOutputTokens` /
 *   `model` overrides.
 * @returns {Promise<string>} The model's text response.
 */
async function callGeminiVision(textPrompt, imageBuffers = [], options = {}) {
  // Use module.exports indirection so tests can swap getGeminiClient.
  const client = await module.exports.getGeminiClient();

  // Phase F.1b: scopeConfig.model wins over the env-resolved default if provided.
  // Explicit options.model wins over scopeConfig.model.
  const scopeConfig = options && typeof options === 'object' ? options.scopeConfig : null;
  const callerModel =
    options && typeof options === 'object' && typeof options.model === 'string' && options.model.trim()
      ? options.model.trim()
      : null;
  const scopeModel =
    scopeConfig && typeof scopeConfig === 'object' && typeof scopeConfig.model === 'string' && scopeConfig.model.trim()
      ? scopeConfig.model.trim()
      : null;
  const preferred = callerModel || scopeModel || null;
  const modelName = resolveModel(preferred, 'GROUPING_MODEL', 'gemini-2.0-flash');
  const model = client.getGenerativeModel({ model: modelName });

  const parts = [
    { text: textPrompt },
    ...imageBuffers.map((img) => ({
      inlineData: {
        mimeType: img.mimeType || 'image/jpeg',
        data: img.buffer.toString('base64'),
      },
    })),
  ];

  // Phase F.1b: merge helper-defaults < scopeConfig.generationConfig < explicit caller overrides.
  const helperDefaults = { temperature: 0.1, maxOutputTokens: 2048 };
  const scopeGenCfg =
    scopeConfig && typeof scopeConfig === 'object' && scopeConfig.generationConfig && typeof scopeConfig.generationConfig === 'object'
      ? scopeConfig.generationConfig
      : null;
  const callerOverrides = {};
  if (options && Object.prototype.hasOwnProperty.call(options, 'temperature') && options.temperature !== undefined) {
    callerOverrides.temperature = options.temperature;
  }
  if (options && Object.prototype.hasOwnProperty.call(options, 'maxOutputTokens') && options.maxOutputTokens !== undefined) {
    callerOverrides.maxOutputTokens = options.maxOutputTokens;
  }
  const generationConfig = { ...helperDefaults };
  if (scopeGenCfg) Object.assign(generationConfig, scopeGenCfg);
  Object.assign(generationConfig, callerOverrides);

  const result = await callGeminiWithRetry(
    () =>
      model.generateContent({
        contents: [{ role: 'user', parts }],
        generationConfig,
      }),
    { maxRetries: 1, delayMs: 2000 }
  );

  return result.response.text();
}

module.exports = {
    getGeminiClient,
    getGeminiApiKey,
    callGeminiVision,
    // for diagnostics / health endpoints
    __unsafeGetCachedKeySource: () => cachedKeySource,
};
