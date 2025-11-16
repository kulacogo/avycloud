const OpenAI = require('openai');
const { getSecretValue } = require('./secret-values');

let cachedClient = null;
let cachedKey = null;

async function getOpenAIApiKey() {
  if (cachedKey) return cachedKey;

  const directKey = process.env.OPENAI_API_KEY;
  if (directKey) {
    cachedKey = directKey;
    return directKey;
  }

  const secret = await getSecretValue('OPENAI_API_KEY');
  if (!secret) {
    throw new Error('OPENAI_API_KEY is not configured in environment variables or Secret Manager');
  }

  cachedKey = secret;
  return secret;
}

async function getOpenAIClient() {
  if (cachedClient) return cachedClient;

  const apiKey = await getOpenAIApiKey();
  cachedClient = new OpenAI({ apiKey });
  return cachedClient;
}

module.exports = {
  getOpenAIClient,
  getOpenAIApiKey,
};

