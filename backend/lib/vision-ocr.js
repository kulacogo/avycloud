const { GoogleAuth } = require('google-auth-library');

const OCR_ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';
const OCR_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const OCR_LANGUAGE_HINTS = (process.env.OCR_LANGUAGE_HINTS || 'de,en,fr,it,es')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);
const OCR_BATCH_SIZE = parseInt(process.env.OCR_BATCH_SIZE || '4', 10);
const OCR_TEXT_SNIPPET_LIMIT = parseInt(process.env.OCR_TEXT_SNIPPET_LIMIT || '40', 10);
const OCR_NUMERIC_LIMIT = parseInt(process.env.OCR_NUMERIC_LIMIT || '60', 10);
const MIN_BARCODE_LENGTH = 8;
const MAX_BARCODE_LENGTH = 18;

function normalizeLine(line = '') {
  return line.replace(/\s+/g, ' ').trim();
}

function normalizeDigits(value = '') {
  return value.replace(/[^\d]/g, '');
}

function computeGtinCheckDigit(code = '') {
  const digits = code.split('').map((char) => parseInt(char, 10));
  let sum = 0;
  for (let i = digits.length - 2, weightIdx = 0; i >= 0; i -= 1, weightIdx += 1) {
    const weight = weightIdx % 2 === 0 ? 3 : 1;
    sum += digits[i] * weight;
  }
  return (10 - (sum % 10)) % 10;
}

function isLikelyGtin(code = '') {
  if (!/^\d+$/.test(code)) return false;
  if (![8, 12, 13, 14].includes(code.length)) {
    return false;
  }
  const expected = computeGtinCheckDigit(code);
  const actual = parseInt(code.slice(-1), 10);
  return expected === actual;
}

function extractNumericTokens(text = '', { minLength = 4, maxItems = OCR_NUMERIC_LIMIT } = {}) {
  if (!text) return [];
  const tokens = [];
  const seen = new Set();
  const matches = text.match(/\d[\d\s\-\.]{2,}/g) || [];
  for (const raw of matches) {
    const normalized = normalizeDigits(raw);
    if (!normalized || normalized.length < minLength) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    tokens.push(normalized);
    if (tokens.length >= maxItems) break;
  }
  return tokens;
}

function extractBarcodeCandidates(text = '') {
  if (!text) return [];
  const candidates = [];
  const seen = new Set();
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const normalizedLine = normalizeDigits(rawLine);
    if (
      normalizedLine.length >= MIN_BARCODE_LENGTH &&
      normalizedLine.length <= MAX_BARCODE_LENGTH &&
      /^\d+$/.test(normalizedLine)
    ) {
      if (seen.has(normalizedLine)) continue;
      seen.add(normalizedLine);
      candidates.push({
        code: normalizedLine,
        priority: isLikelyGtin(normalizedLine) ? 0 : 1,
      });
    }
  }

  const joinedMatches = text.match(/\b\d{8,18}\b/g) || [];
  for (const match of joinedMatches) {
    if (seen.has(match)) continue;
    seen.add(match);
    candidates.push({
      code: match,
      priority: isLikelyGtin(match) ? 0 : 1,
    });
  }

  candidates.sort((a, b) => a.priority - b.priority);
  return candidates.map((entry) => entry.code);
}

async function fetchAccessToken() {
  const auth = new GoogleAuth({
    scopes: [OCR_SCOPE],
  });
  const client = await auth.getClient();
  const accessToken = await client.getAccessToken();
  return accessToken?.token || accessToken;
}

async function callVisionApi(requests = []) {
  if (!requests.length) return [];
  const accessToken = await fetchAccessToken();
  const response = await fetch(OCR_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ requests }),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Vision API failed (${response.status}): ${errorText}`);
  }
  const data = await response.json();
  return Array.isArray(data.responses) ? data.responses : [];
}

function buildRequests(files = []) {
  return files.map((file) => ({
    image: {
      content: file.buffer.toString('base64'),
    },
    features: [
      { type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 },
      { type: 'TEXT_DETECTION', maxResults: 5 },
    ],
    imageContext: OCR_LANGUAGE_HINTS.length ? { languageHints: OCR_LANGUAGE_HINTS } : undefined,
  }));
}

async function extractOcrPayload(files = []) {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      barcodes: [],
      textSnippets: [],
      numericValues: [],
    };
  }

  try {
    const responses = [];
    for (let idx = 0; idx < files.length; idx += OCR_BATCH_SIZE) {
      const batch = files.slice(idx, idx + OCR_BATCH_SIZE);
      const requests = buildRequests(batch);
      const batchResponses = await callVisionApi(requests);
      responses.push(...batchResponses);
    }

    const textSnippets = [];
    const numericValues = [];
    const barcodeCandidates = [];

    for (const response of responses) {
      const fullText = response?.fullTextAnnotation?.text || '';
      if (fullText) {
        fullText
          .split(/\r?\n/)
          .map(normalizeLine)
          .filter(Boolean)
          .forEach((line) => {
            if (textSnippets.length < OCR_TEXT_SNIPPET_LIMIT) {
              textSnippets.push(line);
            }
          });
      }

      const combinedTextParts = [];
      if (fullText) combinedTextParts.push(fullText);
      if (Array.isArray(response?.textAnnotations)) {
        response.textAnnotations.forEach((annotation) => {
          if (annotation?.description) {
            combinedTextParts.push(annotation.description);
          }
        });
      }
      const combinedText = combinedTextParts.join('\n');
      if (combinedText) {
        extractNumericTokens(combinedText).forEach((token) => {
          if (!numericValues.includes(token) && numericValues.length < OCR_NUMERIC_LIMIT) {
            numericValues.push(token);
          }
        });
        extractBarcodeCandidates(combinedText).forEach((code) => {
          barcodeCandidates.push(code);
        });
      }
    }

    const dedupedBarcodes = [];
    const seenCodes = new Set();
    barcodeCandidates.forEach((code) => {
      if (!seenCodes.has(code)) {
        seenCodes.add(code);
        dedupedBarcodes.push(code);
      }
    });

    return {
      barcodes: dedupedBarcodes,
      textSnippets,
      numericValues,
    };
  } catch (error) {
    console.warn('OCR extraction failed, continuing without OCR:', error.message);
    return {
      barcodes: [],
      textSnippets: [],
      numericValues: [],
    };
  }
}

module.exports = {
  extractOcrPayload,
  isLikelyGtin,
};

