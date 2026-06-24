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
  // Protect decimal separators so "1.9" doesn't split into two sentences.
  const DECIMAL_DOT = '__DECIMAL_DOT__';
  const source = safeString(text).replace(/(\d)\.(\d)/g, `$1${DECIMAL_DOT}$2`);
  return (source.match(/[^.!?]+[.!?]?/g) || [])
    .map((s) => s.replace(new RegExp(DECIMAL_DOT, 'g'), '.').trim())
    .filter(Boolean);
}

function stripHtmlTags(text = '') {
  // Remove active/scripted content first.
  return safeString(text)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, ' ')
    // Keep block boundaries as line breaks before removing tags.
    .replace(/<\/?(p|div|section|article|ul|ol|li|br)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

function escapeHtml(text = '') {
  return safeString(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeFactSentence(value = '') {
  const cleaned = normalizeSpaces(value);
  if (!cleaned) return '';
  if (PLACEHOLDER_RE.test(cleaned) || UI_TEMPLATE_RE.test(cleaned) || PRICE_SENTENCE_RE.test(cleaned)) {
    return '';
  }
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function visibleTextLength(text = '') {
  return normalizeSpaces(stripHtmlTags(text)).length;
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

function sanitizeDescriptionToHtml(
  text = '',
  { maxLen = 3000, minVisibleChars = 320, fallbackFacts = [] } = {}
) {
  const hardMax = Math.max(500, Number(maxLen) || 3000);
  const minVisible = Math.max(80, Number(minVisibleChars) || 320);

  const plain = sanitizeListingText(stripHtmlTags(text), { maxLen: Math.max(hardMax * 2, 2000) });
  const baseSentences = splitSentences(plain)
    .map(normalizeFactSentence)
    .filter(Boolean);

  const factSentences = (Array.isArray(fallbackFacts) ? fallbackFacts : [])
    .map(normalizeFactSentence)
    .filter(Boolean);

  const pool = [];
  const seen = new Set();
  const pushSentence = (value) => {
    const s = normalizeFactSentence(value);
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    pool.push(s);
  };

  baseSentences.forEach(pushSentence);
  factSentences.forEach(pushSentence);

  if (!pool.length) return '';

  // Enrich short descriptions with additional factual sentences when available.
  let visibleLen = normalizeSpaces(pool.join(' ')).length;
  if (visibleLen < minVisible) {
    factSentences.forEach((s) => {
      if (visibleLen >= minVisible) return;
      const key = s.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      pool.push(s);
      visibleLen = normalizeSpaces(pool.join(' ')).length;
    });
  }

  const intro = pool.slice(0, 2);
  const tail = pool.slice(2);
  const bullets = tail.filter((s) => s.length >= 24).slice(0, 6);
  const usedBulletKeys = new Set(bullets.map((s) => s.toLowerCase()));
  const details = tail.filter((s) => !usedBulletKeys.has(s.toLowerCase())).slice(0, 3);

  const htmlParts = [];
  if (intro.length) {
    htmlParts.push(`<p>${escapeHtml(intro.join(' '))}</p>`);
  }
  if (bullets.length) {
    htmlParts.push(
      `<ul>${bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    );
  }
  if (details.length) {
    htmlParts.push(`<p>${escapeHtml(details.join(' '))}</p>`);
  }

  let html = htmlParts.join('');
  if (!html) {
    html = `<p>${escapeHtml(pool.join(' '))}</p>`;
  }

  if (visibleTextLength(html) < minVisible && factSentences.length) {
    const extras = factSentences
      .filter((s) => {
        const key = s.toLowerCase();
        return !seen.has(key);
      })
      .slice(0, 3);
    if (extras.length) {
      html += `<p>${escapeHtml(extras.join(' '))}</p>`;
    }
  }

  if (html.length > hardMax) {
    const fallback = sanitizeListingText(stripHtmlTags(html), { maxLen: hardMax - 20 });
    return fallback ? `<p>${escapeHtml(fallback)}</p>` : '';
  }
  return html;
}

/**
 * Prose-preserving description sanitizer.
 *
 * Unlike sanitizeDescriptionToHtml (which sentence-splits text and rebuilds it
 * as intro <p> + <ul><li> + closing <p>), this keeps the model's PARAGRAPH
 * structure as flowing prose and NEVER emits bullet lists. Block tags become
 * paragraph boundaries; any model-supplied <ul>/<li> is flattened into prose.
 * This matches the lived datasheet standard: Beschreibung = Fließtext, bullets
 * live only in the separate key_features (Highlights) field.
 *
 * Same safety/cleaning guarantees as the bulletizer: strips active content,
 * drops price/placeholder/UI-template sentences, escapes HTML, caps length.
 */
function sanitizeDescriptionProse(
  text = '',
  { maxLen = 3000, fallbackFacts = [] } = {}
) {
  const hardMax = Math.max(500, Number(maxLen) || 3000);
  const PARA = '\n\n';

  // Turn block-level boundaries into paragraph delimiters, drop scripted
  // content, then strip every remaining tag. Inline markup (e.g. <strong>) is
  // removed for safety — parity with the existing sanitizer's strip-then-escape
  // approach — but paragraph breaks survive as blank lines.
  const withBreaks = decodeHtmlEntitiesDeep(safeString(text))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, ' ')
    .replace(/<\/(p|div|section|article|ul|ol|li|h[1-6]|tr|blockquote)\s*>/gi, PARA)
    .replace(/<br\s*\/?>/gi, PARA)
    .replace(/<[^>]+>/g, ' ');

  const paragraphs = [];
  const seen = new Set();
  for (const rawPara of withBreaks.split(/\n\s*\n/)) {
    // Reuse the delete-only sentence cleaner (drops banned/price/placeholder).
    const cleaned = normalizeSpaces(sanitizeListingText(rawPara, { maxLen: hardMax }));
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    paragraphs.push(cleaned);
  }

  if (!paragraphs.length) {
    const facts = (Array.isArray(fallbackFacts) ? fallbackFacts : [])
      .map(normalizeFactSentence)
      .filter(Boolean);
    if (facts.length) paragraphs.push(normalizeSpaces(facts.join(' ')));
  }
  if (!paragraphs.length) return '';

  // Assemble <p> blocks, staying under the length cap.
  let html = '';
  for (const para of paragraphs) {
    const next = `${html}<p>${escapeHtml(para)}</p>`;
    if (next.length > hardMax) break;
    html = next;
  }
  if (!html) {
    // First paragraph alone exceeds the cap — hard-trim it.
    const truncated = sanitizeListingText(paragraphs.join(' '), { maxLen: hardMax - 7 });
    return truncated ? `<p>${escapeHtml(truncated)}</p>` : '';
  }
  return html;
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
  sanitizeDescriptionToHtml,
  sanitizeDescriptionProse,
  sanitizeHighlights,
  PLACEHOLDER_RE,
  UI_TEMPLATE_RE,
  PRICE_SENTENCE_RE,
};


