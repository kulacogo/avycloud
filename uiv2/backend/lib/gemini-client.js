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

module.exports = {
    getGeminiClient,
    getGeminiApiKey,
    // for diagnostics / health endpoints
    __unsafeGetCachedKeySource: () => cachedKeySource,
};
