'use strict';

/**
 * Exponential-backoff retry wrapper for Gemini API calls.
 * Retries on transient errors (429 rate limit, 503, timeouts, schema issues).
 */
async function callGeminiWithRetry(fn, { maxRetries = 2, delayMs = 2000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const msg = error?.message || '';
      const isRetryable =
        error?.status === 429 ||
        error?.status === 503 ||
        msg.includes('timeout') ||
        msg.includes('DEADLINE_EXCEEDED') ||
        msg.includes('schema') ||
        msg.includes('RESOURCE_EXHAUSTED');

      if (!isRetryable || attempt === maxRetries) {
        throw error;
      }

      const wait = delayMs * Math.pow(2, attempt);
      console.warn(`[GEMINI RETRY] Attempt ${attempt + 1}/${maxRetries}, waiting ${wait}ms: ${msg}`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastError;
}

module.exports = { callGeminiWithRetry };
