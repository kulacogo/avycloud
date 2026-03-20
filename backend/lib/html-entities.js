function safeString(value) {
  return value == null ? '' : String(value);
}

const NAMED_ENTITY_MAP = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  deg: '°',
  euro: '€',
  copy: '©',
  reg: '®',
  trade: '™',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  middot: '·',
  micro: 'µ',
  plusmn: '±',
  sup2: '²',
  sup3: '³',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  times: '×',
  divide: '÷',
  Auml: 'Ä',
  auml: 'ä',
  Ouml: 'Ö',
  ouml: 'ö',
  Uuml: 'Ü',
  uuml: 'ü',
  szlig: 'ß',
};

function decodeHtmlEntityToken(token) {
  if (!token) return '';
  if (Object.prototype.hasOwnProperty.call(NAMED_ENTITY_MAP, token)) {
    return NAMED_ENTITY_MAP[token];
  }

  if (token.startsWith('#x') || token.startsWith('#X')) {
    const codePoint = Number.parseInt(token.slice(2), 16);
    if (Number.isFinite(codePoint) && codePoint > 0) {
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return `&${token};`;
      }
    }
    return `&${token};`;
  }

  if (token.startsWith('#')) {
    const codePoint = Number.parseInt(token.slice(1), 10);
    if (Number.isFinite(codePoint) && codePoint > 0) {
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return `&${token};`;
      }
    }
    return `&${token};`;
  }

  return `&${token};`;
}

function decodeHtmlEntities(value) {
  const source = safeString(value);
  if (!source) return '';
  return source.replace(/&([a-zA-Z][a-zA-Z0-9]+|#[0-9]+|#x[0-9a-fA-F]+);/g, (_, token) =>
    decodeHtmlEntityToken(token)
  );
}

function decodeHtmlEntitiesDeep(value, maxPasses = 3) {
  let current = safeString(value);
  if (!current) return '';
  const passes = Number.isFinite(maxPasses) ? Math.max(1, Math.min(8, Number(maxPasses))) : 3;
  for (let i = 0; i < passes; i += 1) {
    const next = decodeHtmlEntities(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

/**
 * Sanitize text from external sources (marketplaces, webhooks).
 * Strips HTML tags and decodes entities to prevent XSS.
 */
function sanitizeText(value) {
  if (value == null) return value;
  const str = safeString(value);
  if (!str) return '';
  // Strip HTML tags, then decode entities
  const stripped = str.replace(/<[^>]*>/g, '');
  return decodeHtmlEntitiesDeep(stripped).replace(/\s+/g, ' ').trim();
}

/**
 * Validate and normalize an email address from marketplace data.
 * Returns the trimmed email if valid, null otherwise.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateEmail(value) {
  if (value == null || typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || !EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

module.exports = {
  decodeHtmlEntities,
  decodeHtmlEntitiesDeep,
  sanitizeText,
  validateEmail,
};
