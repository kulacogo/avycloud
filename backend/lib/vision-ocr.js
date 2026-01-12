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
const OCR_FILE_TEXT_LIMIT = parseInt(process.env.OCR_FILE_TEXT_LIMIT || '60', 10);
const OCR_WEB_ENTITY_LIMIT = parseInt(process.env.OCR_WEB_ENTITY_LIMIT || '8', 10);
const OCR_WEB_PAGE_LIMIT = parseInt(process.env.OCR_WEB_PAGE_LIMIT || '6', 10);
const OCR_LOGO_LIMIT = parseInt(process.env.OCR_LOGO_LIMIT || '6', 10);
const MIN_BARCODE_LENGTH = 8;
const MAX_BARCODE_LENGTH = 18;
const MAX_PREPROCESS_EDGE = parseInt(process.env.OCR_MAX_EDGE || '2200', 10);
const BARCODE_LABEL_RE = /\b(ean|gtin|upc|barcode|bar\s*code|strichcode)\b/i;

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
  // HARD RULE:
  // OCR contains many random numeric sequences (serials, dates, sizes, order numbers).
  // We only accept a barcode candidate when it is:
  // - digits-only, length 8/12/13/14, and checkdigit-valid
  // - AND it is either on a labeled line (EAN/GTIN/UPC/Barcode/Strichcode) OR repeated across OCR text.

  const allowedLen = new Set([8, 12, 13, 14]);
  const occurrences = new Map();
  const labeled = new Set();
  const seenFromLines = new Set();

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = normalizeLine(rawLine);
    if (!line) continue;

    // Collect any digit blocks from this line
    const matches = line.match(/\b\d[\d\s\-\.]{6,}\b/g) || [];
    for (const raw of matches) {
      const code = normalizeDigits(raw);
      if (!code || !/^\d+$/.test(code)) continue;
      if (!allowedLen.has(code.length)) continue;
      if (!isValidGtin(code)) continue;
      seenFromLines.add(code);
      occurrences.set(code, (occurrences.get(code) || 0) + 1);
      if (BARCODE_LABEL_RE.test(line)) {
        labeled.add(code);
      }
    }
  }

  // Also catch joined tokens (single-line OCR blocks without separators)
  const joinedMatches = text.match(/\b\d{8,14}\b/g) || [];
  for (const raw of joinedMatches) {
    const code = normalizeDigits(raw);
    if (!code || !/^\d+$/.test(code)) continue;
    if (!allowedLen.has(code.length)) continue;
    if (!isValidGtin(code)) continue;
    // Avoid double-counting the same occurrence that was already captured in the line-pass.
    if (seenFromLines.has(code)) continue;
    occurrences.set(code, (occurrences.get(code) || 0) + 1);
  }

  const strong = [];
  for (const [code, count] of occurrences.entries()) {
    if (labeled.has(code) || count >= 2) {
      strong.push(code);
    }
  }

  // Prefer labeled, then most frequent
  strong.sort((a, b) => {
    const aL = labeled.has(a) ? 1 : 0;
    const bL = labeled.has(b) ? 1 : 0;
    if (aL !== bL) return bL - aL;
    return (occurrences.get(b) || 0) - (occurrences.get(a) || 0);
  });

  return strong;
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
      // Google Lens-like signals (official Vision feature):
      // https://cloud.google.com/vision/docs/detecting-web
      { type: 'WEB_DETECTION', maxResults: 10 },
      { type: 'LOGO_DETECTION', maxResults: 5 },
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
      web: {
        bestGuessLabels: [],
        webEntities: [],
        pagesWithMatchingImages: [],
        logos: [],
      },
      byFile: [],
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
    const byFile = Array(files.length)
      .fill(null)
      .map(() => ({
        textLines: [],
        textLen: 0,
        barcodes: [],
        web: {
          bestGuessLabels: [],
          webEntities: [],
          pagesWithMatchingImages: [],
          logos: [],
        },
      }));

    const bestGuessLabels = new Set();
    const webEntitiesByDesc = new Map(); // desc -> max score
    const logoByDesc = new Map(); // desc -> max score
    const pagesWithMatchingImages = new Set();

    for (const { response, fileIndex } of responses) {
      const fileEntry = byFile[fileIndex] || null;
      const fullText = response?.fullTextAnnotation?.text || '';
      if (fileEntry) {
        fileEntry.textLen += typeof fullText === 'string' ? fullText.length : 0;
      }
      if (fullText) {
        fullText
          .split(/\r?\n/)
          .map(normalizeLine)
          .filter(Boolean)
          .forEach((line) => {
            if (textSnippets.length < OCR_TEXT_SNIPPET_LIMIT) {
              textSnippets.push(line);
            }
            if (fileEntry && fileEntry.textLines.length < OCR_FILE_TEXT_LIMIT) {
              fileEntry.textLines.push(line);
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
              if (fileEntry) {
                fileEntry.barcodes.push(digitsOnly);
              }
            }
          }
        });
      }

      // WEB_DETECTION + LOGO_DETECTION (best-effort).
      // Used to approximate Google Lens results without external search keys.
      try {
        const webDetection = response?.webDetection || null;
        if (webDetection) {
          const labels = Array.isArray(webDetection.bestGuessLabels) ? webDetection.bestGuessLabels : [];
          labels.forEach((entry) => {
            const label = normalizeLine(entry?.label || entry?.description || entry || '');
            if (!label) return;
            bestGuessLabels.add(label);
            if (fileEntry && fileEntry.web.bestGuessLabels.length < OCR_WEB_ENTITY_LIMIT) {
              fileEntry.web.bestGuessLabels.push(label);
            }
          });

          const entities = Array.isArray(webDetection.webEntities) ? webDetection.webEntities : [];
          entities.forEach((entity) => {
            const desc = normalizeLine(entity?.description || '');
            if (!desc) return;
            const score = Number(entity?.score || 0) || 0;
            const prev = webEntitiesByDesc.get(desc) || 0;
            if (score > prev) webEntitiesByDesc.set(desc, score);
            if (fileEntry && fileEntry.web.webEntities.length < OCR_WEB_ENTITY_LIMIT) {
              fileEntry.web.webEntities.push({ description: desc, score });
            }
          });

          const pages = Array.isArray(webDetection.pagesWithMatchingImages)
            ? webDetection.pagesWithMatchingImages
            : [];
          pages.forEach((page) => {
            const url = normalizeLine(page?.url || '');
            if (!url) return;
            pagesWithMatchingImages.add(url);
            if (fileEntry && fileEntry.web.pagesWithMatchingImages.length < OCR_WEB_PAGE_LIMIT) {
              fileEntry.web.pagesWithMatchingImages.push(url);
            }
          });
        }

        const logos = Array.isArray(response?.logoAnnotations) ? response.logoAnnotations : [];
        logos.forEach((logo) => {
          const desc = normalizeLine(logo?.description || '');
          if (!desc) return;
          const score = Number(logo?.score || 0) || 0;
          const prev = logoByDesc.get(desc) || 0;
          if (score > prev) logoByDesc.set(desc, score);
          if (fileEntry && fileEntry.web.logos.length < OCR_LOGO_LIMIT) {
            fileEntry.web.logos.push({ description: desc, score });
          }
        });
      } catch {
        // ignore web detection parsing errors
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

    const webEntities = Array.from(webEntitiesByDesc.entries())
      .map(([description, score]) => ({ description, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, OCR_WEB_ENTITY_LIMIT);
    const logos = Array.from(logoByDesc.entries())
      .map(([description, score]) => ({ description, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, OCR_LOGO_LIMIT);

    const bestGuess = Array.from(bestGuessLabels).slice(0, OCR_WEB_ENTITY_LIMIT);
    const pages = Array.from(pagesWithMatchingImages).slice(0, OCR_WEB_PAGE_LIMIT);

    // Deduplicate per-file barcodes
    byFile.forEach((entry) => {
      if (!entry) return;
      entry.barcodes = Array.from(new Set((entry.barcodes || []).filter(Boolean)));
      if (Array.isArray(entry.web?.webEntities)) {
        entry.web.webEntities = entry.web.webEntities
          .filter((e) => e && e.description)
          .sort((a, b) => (Number(b.score || 0) || 0) - (Number(a.score || 0) || 0))
          .slice(0, OCR_WEB_ENTITY_LIMIT);
      }
      if (Array.isArray(entry.web?.logos)) {
        entry.web.logos = entry.web.logos
          .filter((e) => e && e.description)
          .sort((a, b) => (Number(b.score || 0) || 0) - (Number(a.score || 0) || 0))
          .slice(0, OCR_LOGO_LIMIT);
      }
      if (Array.isArray(entry.web?.bestGuessLabels)) {
        entry.web.bestGuessLabels = Array.from(new Set(entry.web.bestGuessLabels)).slice(0, OCR_WEB_ENTITY_LIMIT);
      }
      if (Array.isArray(entry.web?.pagesWithMatchingImages)) {
        entry.web.pagesWithMatchingImages = Array.from(new Set(entry.web.pagesWithMatchingImages)).slice(0, OCR_WEB_PAGE_LIMIT);
      }
    });

    return {
      barcodes: dedupedBarcodes,
      barcodeDetails,
      textSnippets,
      numericValues,
      web: {
        bestGuessLabels: bestGuess,
        webEntities,
        pagesWithMatchingImages: pages,
        logos,
      },
      byFile,
    };
  } catch (error) {
    console.warn('OCR extraction failed, continuing without OCR:', error.message);
    return {
      barcodes: [],
      barcodeDetails: [],
      textSnippets: [],
      numericValues: [],
      web: {
        bestGuessLabels: [],
        webEntities: [],
        pagesWithMatchingImages: [],
        logos: [],
      },
      byFile: [],
    };
  }
}

module.exports = {
  extractOcrPayload,
  isLikelyGtin: isValidGtin,
  isValidGtin,
};

