const { GoogleGenerativeAI } = require('@google/generative-ai');
const { getSecretValue } = require('./secret-values');

let cachedClient = null;
let cachedKey = null;

async function getGeminiApiKey() {
    if (cachedKey) return cachedKey;

    const directKey = process.env.GEMINI_API_KEY;
    if (directKey) {
        cachedKey = directKey;
        return directKey;
    }

    const secret = await getSecretValue('GEMINI_API_KEY');
    if (!secret) {
        throw new Error('GEMINI_API_KEY is not configured in environment variables or Secret Manager');
    }

    cachedKey = secret;
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
};
