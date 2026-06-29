/**
 * Regression tests for literal backslash-escape leakage in description text.
 *
 * Incident 2026-06-29 (SKU-6717172932, Funko Freddie Mercury #184):
 * The Gemini model OVER-ESCAPED newlines inside its HTML description — it
 * emitted "\\n" (backslash + n) in the JSON function-call argument instead of a
 * real newline. JSON.parse decoded that to the two-character LITERAL sequence
 * backslash+n, which then flowed unmodified into details.short_description and
 * rendered as visible garbage ("\n\n \n Einzigartiges Set: ...") inside the
 * stored <li>/<p>.
 *
 * Root cause: none of the shared sanitizer primitives de-literalize escape
 * sequences. escapeHtml() does not escape backslash, and normalizeSpaces()'s
 * /\s+/ does not match a literal backslash-n (0x5C 0x6E, not 0x0A).
 *
 * NOTE: in this source file, the JS literal '\\n' is the two characters
 * backslash + n — exactly what was stored in Firestore.
 */
const {
  sanitizeDescriptionProse,
  sanitizeDescriptionToHtml,
  sanitizeListingText,
  sanitizeHighlights,
} = require('../../lib/listing-sanitize');

const LITERAL_BACKSLASH_N = '\\n'; // two chars: backslash, n

describe('literal escape-sequence normalization', () => {
  // The exact corruption shape from the real product (literal backslash-n).
  const REPRO =
    'Holen Sie sich die unvergleichliche Energie von Queen direkt nach Hause.' +
    '\\n\\n \\n Einzigartiges Set: Neben der ca. 10 cm hohen Vinyl-Figur enthaelt ' +
    'diese Special Edition einen hochwertigen Emaille-Pin.' +
    '\\n Perfekt fuer Sammler: kommt in der weltweit beliebten Fensterbox.';

  it('sanitizeDescriptionProse never emits a literal backslash-n', () => {
    const out = sanitizeDescriptionProse(REPRO);
    expect(out).not.toContain(LITERAL_BACKSLASH_N);
    // real content survives the cleaning
    expect(out).toContain('Einzigartiges Set');
    expect(out).toContain('Emaille-Pin');
    expect(out).toContain('Fensterbox');
  });

  it('sanitizeDescriptionToHtml never emits a literal backslash-n', () => {
    const out = sanitizeDescriptionToHtml(REPRO);
    expect(out).not.toContain(LITERAL_BACKSLASH_N);
    expect(out).toContain('Einzigartiges Set');
  });

  it('sanitizeListingText never emits a literal backslash-n', () => {
    const out = sanitizeListingText(REPRO);
    expect(out).not.toContain(LITERAL_BACKSLASH_N);
    expect(out).toContain('Einzigartiges Set');
  });

  it('normalizes literal \\r\\n and \\t escape sequences too', () => {
    const input = 'Zeile eins.\\r\\nZeile zwei mit Tab\\there.';
    const out = sanitizeDescriptionProse(input);
    expect(out).not.toContain('\\r');
    expect(out).not.toContain('\\t');
    expect(out).not.toContain(LITERAL_BACKSLASH_N);
    expect(out).toContain('Zeile eins');
    expect(out).toContain('Zeile zwei');
  });

  it('treats a literal \\n\\n as a real paragraph break in prose', () => {
    const input =
      'Erster Absatz mit ausreichender Laenge fuer einen vollen Satz hier.' +
      '\\n\\n' +
      'Zweiter Absatz ebenfalls lang genug fuer einen eigenen Block hier.';
    const out = sanitizeDescriptionProse(input);
    expect(out).not.toContain(LITERAL_BACKSLASH_N);
    // two separate paragraphs, not one run-on
    expect((out.match(/<p>/g) || []).length).toBe(2);
  });

  it('strips literal backslash-n from highlights', () => {
    const out = sanitizeHighlights([
      'Ikonisches Design im Wembley-Outfit\\n mit Krone und Umhang',
      '\\n\\nExklusive Platinum Metallic Edition fuer Sammler',
    ]);
    expect(out.join(' ')).not.toContain(LITERAL_BACKSLASH_N);
    expect(out.length).toBe(2);
  });
});
