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

/**
 * De-literalize escape sequences that should have been real whitespace.
 *
 * Upstream producers — notably LLMs that OVER-ESCAPE newlines inside a JSON
 * function-call argument — emit the LITERAL two-character sequences `\n` / `\r`
 * / `\t` (a backslash followed by the letter) where a real newline/tab was
 * intended. These are invisible to normalizeSpaces (its /\s+/ does NOT match a
 * literal backslash-n, which is bytes 0x5C 0x6E, not 0x0A) and to escapeHtml
 * (which never touches a backslash), so without this step they leak straight
 * into stored listing text and render as visible garbage like
 * "\n\n \n Einzigartiges Set: ...". Incident 2026-06-29 (SKU-6717172932).
 *
 * Consistent with existing repo behavior (generative-identify.js unescapes a
 * literal \n to a real newline). A backslash-n in legitimate German listing
 * copy (e.g. a Windows path) is effectively nonexistent in this catalog, so the
 * trade-off strongly favors de-literalizing.
 */
function normalizeLiteralEscapes(text = '') {
  return safeString(text)
    .replace(/\\r\\n/g, '\n')
    .replace(/\\[rn]/g, '\n')
    .replace(/\\t/g, ' ');
}

function normalizeSpaces(text = '') {
  return normalizeLiteralEscapes(decodeHtmlEntitiesDeep(safeString(text)))
    .replace(/\s+/g, ' ')
    .trim();
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
  const withBreaks = normalizeLiteralEscapes(decodeHtmlEntitiesDeep(safeString(text)))
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, ' ')
    .replace(/<\/(p|div|section|article|ul|ol|li|h[1-6]|tr|blockquote)\s*>/gi, PARA)
    .replace(/<br\s*\/?>/gi, PARA)
    .replace(/<[^>]+>/g, ' ')
    // Klartext-Bullets ("• ", "- ", "* " am Zeilenanfang) sind ebenfalls
    // Listen: Zeile wird eigener Absatz, die Glyphe entfernt. Bindestriche
    // mitten im Satz (z. B. "10 - 20 m²") bleiben unberührt (brauchen \n/^).
    .replace(/(?:^|\n)[ \t]*[-*•‣▪][ \t]+/g, PARA);

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

/**
 * Universal save-boundary guard: de-literalize escape sequences in EVERY
 * description-bearing text field of a product. Returns a shallow-cleaned copy
 * (pure — never mutates the input).
 *
 * Why this exists in addition to the per-call sanitizers: several RAW write
 * paths copy an LLM string verbatim into the product (identify-v4 mobile_snippet
 * → short_description, the grounding pipeline, batch-optimize's verbatim copy).
 * Running this once inside saveProduct() right before the Firestore write means
 * NO writer — present or future — can persist a literal backslash-n, and any
 * already-stored corruption self-heals the next time the product is saved.
 * Incident 2026-06-29 (SKU-6717172932).
 */
function deLiteralizeProductTextFields(product) {
  if (!product || typeof product !== 'object') return product;
  const deLit = (v) => (typeof v === 'string' ? normalizeLiteralEscapes(v) : v);
  const out = { ...product };

  if (out.details && typeof out.details === 'object') {
    out.details = { ...out.details };
    out.details.short_description = deLit(out.details.short_description);
    out.details.description = deLit(out.details.description);
    if (Array.isArray(out.details.key_features)) {
      out.details.key_features = out.details.key_features.map(deLit);
    }
  }

  if (out.marketplace && typeof out.marketplace === 'object') {
    out.marketplace = { ...out.marketplace };
    for (const channel of ['ebay', 'kaufland']) {
      const chan = out.marketplace[channel];
      if (chan && typeof chan === 'object') {
        out.marketplace[channel] = { ...chan };
        out.marketplace[channel].description = deLit(chan.description);
        out.marketplace[channel].mobile_snippet = deLit(chan.mobile_snippet);
      }
    }
  }

  return out;
}

/**
 * Universal save-boundary prose guard for the datasheet description.
 *
 * The lived standard is: Beschreibung = Fließtext (prose), Highlights =
 * bullets (key_features). The identify/improve generators already emit prose
 * via sanitizeDescriptionProse, but RAW writers — chiefly the chat pipelines,
 * which store `details.short_description` VERBATIM — can persist a
 * `<p>…</p><ul><li>…</li></ul><p>…</p>` description straight from the model.
 *
 * This flattens any list markup in `short_description` to prose so no writer
 * can persist bullets in the description. It only rewrites when list markup is
 * actually present, so a clean, already-prose description is left byte-identical
 * (idempotent — no re-flow / data loss on unrelated saves). key_features
 * (Highlights) are intentionally untouched — they stay bullets.
 */
// Listen-Erkennung: HTML-Listen ODER Klartext-Bullet-Zeilen ("• ", "- ", "* "
// nach Zeilenanfang/<br>). Bindestriche mitten im Satz matchen nicht.
function hasListMarkup(text) {
  if (typeof text !== 'string') return false;
  return /<(ul|ol|li)\b/i.test(text) || /(?:^|\n|<br\s*\/?\s*>)[ \t]*[-*•‣▪][ \t]+/i.test(text);
}

function enforceDescriptionProse(product) {
  if (!product || typeof product !== 'object') return product;
  const desc = product.details && product.details.short_description;
  if (typeof desc !== 'string' || !hasListMarkup(desc)) return product;
  return {
    ...product,
    details: { ...product.details, short_description: sanitizeDescriptionProse(desc) },
  };
}

module.exports = {
  containsBannedListingText,
  normalizeLiteralEscapes,
  deLiteralizeProductTextFields,
  enforceDescriptionProse,
  hasListMarkup,
  sanitizeListingText,
  sanitizeDescriptionToHtml,
  sanitizeDescriptionProse,
  sanitizeHighlights,
  PLACEHOLDER_RE,
  UI_TEMPLATE_RE,
  PRICE_SENTENCE_RE,
};


