/* eslint-disable no-console */
/**
 * Regression checks for OCR barcode candidate extraction.
 *
 * This does NOT call Google Vision. It only tests the text-based barcode filtering logic
 * used by OCR output processing in backend/lib/vision-ocr.js.
 *
 * Usage:
 *   node backend/scripts/test-ocr-barcode-filter.js
 */

const { extractOcrPayload } = require('../lib/vision-ocr');

// We reuse the internal logic by calling extractOcrPayload with empty files? No (it exits early).
// So we duplicate the relevant behavior via a small helper that mirrors OCR post-processing:
const { normalizeDigits, isValidGtin } = require('../lib/gtin');

// Keep in sync with backend/lib/vision-ocr.js (label+repeat gate)
const BARCODE_LABEL_RE = /\b(ean|gtin|upc|barcode|bar\s*code|strichcode)\b/i;
const allowedLen = new Set([8, 12, 13, 14]);

function extractBarcodesFromText(text) {
  const normalizeLine = (line = '') => line.replace(/\s+/g, ' ').trim();
  const occurrences = new Map();
  const labeled = new Set();
  const seenFromLines = new Set();
  const lines = (text || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = normalizeLine(rawLine);
    if (!line) continue;
    const matches = line.match(/\b\d[\d\s\-\.]{6,}\b/g) || [];
    for (const raw of matches) {
      const code = normalizeDigits(raw);
      if (!code || !/^\d+$/.test(code)) continue;
      if (!allowedLen.has(code.length)) continue;
      if (!isValidGtin(code)) continue;
      seenFromLines.add(code);
      occurrences.set(code, (occurrences.get(code) || 0) + 1);
      if (BARCODE_LABEL_RE.test(line)) labeled.add(code);
    }
  }
  const joinedMatches = (text || '').match(/\b\d{8,14}\b/g) || [];
  for (const raw of joinedMatches) {
    const code = normalizeDigits(raw);
    if (!code || !/^\d+$/.test(code)) continue;
    if (!allowedLen.has(code.length)) continue;
    if (!isValidGtin(code)) continue;
    if (seenFromLines.has(code)) continue;
    occurrences.set(code, (occurrences.get(code) || 0) + 1);
  }
  const strong = [];
  for (const [code, count] of occurrences.entries()) {
    if (labeled.has(code) || count >= 2) strong.push(code);
  }
  strong.sort((a, b) => {
    const aL = labeled.has(a) ? 1 : 0;
    const bL = labeled.has(b) ? 1 : 0;
    if (aL !== bL) return bL - aL;
    return (occurrences.get(b) || 0) - (occurrences.get(a) || 0);
  });
  return strong;
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERT FAILED: ${msg}`);
  }
}

function run() {
  // Random numbers (sizes, dates) should be rejected unless labeled or repeated.
  const sample1 = `
Calvin Klein
Gr. M 32/34
100% Cotton
8719114322466
Artikel: 2024-10-01
`.trim();
  const out1 = extractBarcodesFromText(sample1);
  // 8719114322466 is a valid EAN-13 (checkdigit OK) but in this sample it is NOT labeled and appears once -> reject
  assert(out1.length === 0, `expected no barcodes, got ${JSON.stringify(out1)}`);

  // Labeled line should be accepted
  const sample2 = `
EAN: 8719114322466
`.trim();
  const out2 = extractBarcodesFromText(sample2);
  assert(out2[0] === '8719114322466', `expected labeled EAN, got ${JSON.stringify(out2)}`);

  // Repeated valid code (even without label) should be accepted (common OCR duplication)
  const sample3 = `
8719114322466
Text
8719114322466
`.trim();
  const out3 = extractBarcodesFromText(sample3);
  assert(out3[0] === '8719114322466', `expected repeated EAN, got ${JSON.stringify(out3)}`);

  // Invalid checkdigit must be rejected even if labeled
  const sample4 = `
EAN 8719114322467
`.trim();
  const out4 = extractBarcodesFromText(sample4);
  assert(out4.length === 0, `expected invalid EAN to be rejected, got ${JSON.stringify(out4)}`);

  console.log('OK: OCR barcode filter regression checks passed.');
}

run();

