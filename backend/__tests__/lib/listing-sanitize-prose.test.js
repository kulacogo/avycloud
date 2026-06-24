/**
 * Tests for sanitizeDescriptionProse — the prose-preserving description sanitizer.
 *
 * The lived datasheet standard: the Beschreibung is FLOWING PROSE (Fließtext),
 * never a bullet list. Bullets belong in the separate key_features field.
 * This contrasts with sanitizeDescriptionToHtml, which deliberately rebuilds
 * text as intro <p> + <ul><li> + closing <p>.
 */
const {
  sanitizeDescriptionProse,
  sanitizeDescriptionToHtml,
} = require('../../lib/listing-sanitize');

describe('sanitizeDescriptionProse', () => {
  it('keeps multi-paragraph prose as <p> blocks and never emits <ul>/<li>', () => {
    const input =
      '<p>Diese Funko Pop Figur ist ein Muss fuer jeden Sammler und Fan.</p>' +
      '<p>Die detailgetreue Vinyl-Figur feiert einen der dynamischsten Spieler der Liga.</p>';

    const out = sanitizeDescriptionProse(input);

    expect(out).toContain('<p>');
    expect(out).not.toContain('<ul>');
    expect(out).not.toContain('<li>');
    expect(out).toContain('Sammler');
    expect(out).toContain('dynamischsten');
    // two distinct paragraphs preserved
    expect((out.match(/<p>/g) || []).length).toBe(2);
  });

  it('flattens a model-supplied <ul> list into prose paragraphs (no bullets survive)', () => {
    const input =
      '<p>Holen Sie sich den MVP direkt nach Hause.</p>' +
      '<ul>' +
      '<li>Offiziell lizenzierte NFL Merchandise Sammelfigur fuer Fans.</li>' +
      '<li>Detailreiches Design mit charakteristischem Purple Jersey.</li>' +
      '</ul>';

    const out = sanitizeDescriptionProse(input);

    expect(out).not.toContain('<ul>');
    expect(out).not.toContain('<li>');
    expect(out).toContain('<p>');
    // the list content is preserved, just not as bullets
    expect(out).toContain('Offiziell lizenzierte NFL Merchandise');
    expect(out).toContain('Purple Jersey');
  });

  it('returns flowing prose for a plain-text input (single <p>, no bullets)', () => {
    const input =
      'Robuste Fertigung aus langlebigem Vinyl fuer dauerhafte Freude. ' +
      'Ideale Ausstellungsgroesse mit circa 10 cm Hoehe fuer jede Vitrine.';

    const out = sanitizeDescriptionProse(input);

    expect(out).not.toContain('<ul>');
    expect(out).not.toContain('<li>');
    expect(out).toMatch(/^<p>/);
    expect(out).toContain('langlebigem Vinyl');
    expect(out).toContain('Ausstellungsgroesse');
  });

  it('strips active/scripted content', () => {
    const input = '<script>alert(1)</script><p>Sicherer Beschreibungstext hier drin.</p>';
    const out = sanitizeDescriptionProse(input);
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('Sicherer Beschreibungstext');
  });

  it('produces well-formed HTML and escapes special characters in the text', () => {
    const input = '<p>Hergestellt von Mueller & Sohn fuer "Profis" und Sammler.</p>';
    const out = sanitizeDescriptionProse(input);
    // ampersand + quotes escaped (escapeHtml), output stays valid
    expect(out).toContain('&amp;');
    expect(out).toContain('&quot;');
    // the only tags emitted are paragraph wrappers
    const tags = out.match(/<[^>]+>/g) || [];
    expect(tags.every((t) => t === '<p>' || t === '</p>')).toBe(true);
    expect(out).toContain('Mueller');
  });

  it('drops price sentences (banned listing content)', () => {
    const input =
      '<p>Hochwertige Sammelfigur fuer echte Fans und Sammler.</p>' +
      '<p>Unser Preis betraegt nur 69,95 EUR fuer Sie.</p>';
    const out = sanitizeDescriptionProse(input);
    expect(out).not.toContain('69,95');
    expect(out).not.toMatch(/EUR/i);
    expect(out).toContain('Sammelfigur');
  });

  it('returns empty string for empty input and no fallback facts', () => {
    expect(sanitizeDescriptionProse('')).toBe('');
    expect(sanitizeDescriptionProse(null)).toBe('');
    expect(sanitizeDescriptionProse(undefined)).toBe('');
  });

  it('builds a <p> from fallbackFacts when the text is empty', () => {
    const out = sanitizeDescriptionProse('', {
      fallbackFacts: ['Material aus langlebigem Vinyl', 'Hoehe circa 10 cm'],
    });
    expect(out).toContain('<p>');
    expect(out).not.toContain('<ul>');
    expect(out).toContain('Vinyl');
  });

  it('respects the maxLen cap', () => {
    const long = 'Dies ist ein langer Beschreibungssatz fuer das Produkt. '.repeat(200);
    const out = sanitizeDescriptionProse(long, { maxLen: 600 });
    expect(out.length).toBeLessThanOrEqual(600);
    expect(out).not.toContain('<ul>');
  });

  it('differs from sanitizeDescriptionToHtml: prose has no <ul> where the bulletizer would add one', () => {
    const input =
      'Erster Einleitungssatz mit ausreichender Laenge hier drin. ' +
      'Zweiter Satz ebenfalls lang genug fuer die Liste hier. ' +
      'Dritter Benefit-Satz mit genuegend Zeichen fuer Bullets. ' +
      'Vierter Benefit-Satz auch lang genug um zu erscheinen.';

    const bulleted = sanitizeDescriptionToHtml(input);
    const prose = sanitizeDescriptionProse(input);

    // Confirm the bulletizer DOES produce a list for this input (guards the contrast)
    expect(bulleted).toContain('<ul>');
    // The prose variant must NOT
    expect(prose).not.toContain('<ul>');
    expect(prose).not.toContain('<li>');
  });
});
