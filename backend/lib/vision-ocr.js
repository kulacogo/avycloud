const { GoogleAuth } = require('google-auth-library');
const sharp = require('sharp');
const { normalizeDigits, isValidGtin } = require('./gtin');

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
const MAX_PREPROCESS_EDGE = parseInt(process.env.OCR_MAX_EDGE || '2200', 10);

function normalizeLine(line = '') {
  return line.replace(/\s+/g, ' ').trim();
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
        priority: isValidGtin(normalizedLine) ? 0 : 1,
      });
    }
  }

  const joinedMatches = text.match(/\b\d{8,18}\b/g) || [];
  for (const match of joinedMatches) {
    if (seen.has(match)) continue;
    seen.add(match);
    candidates.push({
      code: match,
      priority: isValidGtin(match) ? 0 : 1,
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

async function preprocessImageBuffer(buffer) {
  try {
    const pipeline = sharp(buffer).rotate();
    const metadata = await pipeline.metadata();
    const longest = Math.max(metadata.width || 0, metadata.height || 0);
    if (longest > MAX_PREPROCESS_EDGE) {
      pipeline.resize({ width: MAX_PREPROCESS_EDGE, height: MAX_PREPROCESS_EDGE, fit: 'inside', withoutEnlargement: true });
    }
    return await pipeline.normalize().toBuffer();
  } catch (error) {
    console.warn('OCR preprocess failed, using original buffer:', error.message);
    return buffer;
  }
}

async function buildRequests(files = []) {
  const normalized = await Promise.all(
    files.map(async (file) => ({
      ...file,
      buffer: await preprocessImageBuffer(file.buffer),
    }))
  );
  return normalized.map((file) => ({
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
      barcodeDetails: [],
      textSnippets: [],
      numericValues: [],
    };
  }

  try {
    const responses = [];
    for (let idx = 0; idx < files.length; idx += OCR_BATCH_SIZE) {
      const batch = files.slice(idx, idx + OCR_BATCH_SIZE);
      const requests = await buildRequests(batch);
      const batchResponses = await callVisionApi(requests);
      batchResponses.forEach((entry, responseIdx) => {
        responses.push({
          response: entry,
          fileIndex: idx + responseIdx,
        });
      });
    }

    const textSnippets = [];
    const numericValues = [];
    const barcodeCandidates = [];

    const barcodeDetails = [];

    for (const { response, fileIndex } of responses) {
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
        response.textAnnotations.forEach((annotation, annotationIndex) => {
          if (annotation?.description) {
            combinedTextParts.push(annotation.description);
            const digitsOnly = normalizeDigits(annotation.description);
            if (
              digitsOnly.length >= MIN_BARCODE_LENGTH &&
              digitsOnly.length <= MAX_BARCODE_LENGTH &&
              /^\d+$/.test(digitsOnly)
            ) {
              barcodeDetails.push({
                code: digitsOnly,
                source: annotationIndex === 0 ? 'fullText' : 'textAnnotation',
                isValidGtin: isValidGtin(digitsOnly),
                fileIndex,
                boundingPoly: annotation.boundingPoly || null,
                confidence: annotation.score ?? null,
              });
            }
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
      barcodeDetails,
      textSnippets,
      numericValues,
    };
  } catch (error) {
    console.warn('OCR extraction failed, continuing without OCR:', error.message);
    return {
      barcodes: [],
      barcodeDetails: [],
      textSnippets: [],
      numericValues: [],
    };
  }
}

module.exports = {
  extractOcrPayload,
  isLikelyGtin: isValidGtin,
  isValidGtin,
};

