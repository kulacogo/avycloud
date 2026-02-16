/* eslint-disable no-console */
/**
 * Sanitizers for marketplace listing text.
 *
 * Goal:
 * - Remove banned content from AI-generated / templated text:
 *   - price mentions (€, EUR, "Preisorientierung", "Preisempfehlung", etc.)
 *   - placeholder phrases ("Beschreibung folgt", "Unbekanntes Produkt", etc.)
 *   - UI template sentence ("bringt moderne Küchentechnik ...")
 *
 * IMPORTANT:
 * - We do NOT invent new content here. We only delete/clean.
 */
const { decodeHtmlEntitiesDeep } = require('./html-entities');

function safeString(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function normalizeSpaces(text = '') {
  return decodeHtmlEntitiesDeep(safeString(text)).replace(/\s+/g, ' ').trim();
}

const PLACEHOLDER_RE =
  /(beschreibung folgt|unbekanntes produkt|für dieses produkt liegt noch keine ausführliche beschreibung vor|^produkt\s*\d+\s*[–-]\s*beschreibung folgt|^ürün\s*\d+\s*[–-]\s*beschreibung folgt)/i;

// This is the exact UI fallback sentence we must never store or encourage.
const UI_TEMPLATE_RE =
  /bringt moderne küchentechnik und komfortable bedienung zusammen\.?/i;

// Keep this focused on actual pricing patterns, not generic "preiswert".
const PRICE_SENTENCE_RE =
  /(?:€|\beur\b|\bpreis(?:orientierung|empfehlung)?\b|\bprice\b)/i;

function splitSentences(text) {
  return (safeString(text).match(/[^.!?]+[.!?]?/g) || [])
    .map((s) => s.trim())
    .filter(Boolean);
}

function containsBannedListingText(text = '') {
  const t = safeString(text);
  if (!t.trim()) return false;
  return (
    PLACEHOLDER_RE.test(t) ||
    UI_TEMPLATE_RE.test(t) ||
    PRICE_SENTENCE_RE.test(t)
  );
}

function sanitizeListingText(text = '', { maxLen = 2000 } = {}) {
  const raw = decodeHtmlEntitiesDeep(safeString(text))
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (!raw) return '';

  const paragraphs = raw.split(/\n\s*\n/);
  const cleaned = [];

  for (const para of paragraphs) {
    const sentences = splitSentences(para);
    const kept = [];
    for (const sentence of sentences) {
      const s = normalizeSpaces(sentence);
      if (!s) continue;
      if (PLACEHOLDER_RE.test(s)) continue;
      if (UI_TEMPLATE_RE.test(s)) continue;
      if (PRICE_SENTENCE_RE.test(s)) continue;
      kept.push(s);
    }
    const rebuilt = normalizeSpaces(kept.join(' '));
    if (rebuilt) cleaned.push(rebuilt);
  }

  const out = cleaned.join('\n\n').trim();
  if (!out) return '';
  if (out.length <= maxLen) return out;
  return out.slice(0, maxLen).trim();
}

function sanitizeHighlights(list = [], { minLen = 8, maxItems = 7 } = {}) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const v = normalizeSpaces(raw);
    if (!v) continue;
    if (v.length < minLen) continue;
    if (PLACEHOLDER_RE.test(v)) continue;
    if (UI_TEMPLATE_RE.test(v)) continue;
    if (PRICE_SENTENCE_RE.test(v)) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= maxItems) break;
  }
  return out;
}

module.exports = {
  containsBannedListingText,
  sanitizeListingText,
  sanitizeHighlights,
  PLACEHOLDER_RE,
  UI_TEMPLATE_RE,
  PRICE_SENTENCE_RE,
};


