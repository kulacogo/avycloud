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
 * @param {object} [options]
 * @returns {Promise<string>} The model's text response.
 */
async function callGeminiVision(textPrompt, imageBuffers = [], options = {}) {
  const client = await getGeminiClient();
  const modelName = resolveModel(null, 'GROUPING_MODEL', 'gemini-2.0-flash');
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

  const result = await callGeminiWithRetry(
    () =>
      model.generateContent({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: options.temperature ?? 0.1,
          maxOutputTokens: options.maxOutputTokens ?? 2048,
        },
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
