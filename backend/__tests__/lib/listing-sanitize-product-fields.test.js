'use strict';

/**
 * Tests for deLiteralizeProductTextFields — the UNIVERSAL save-boundary guard.
 *
 * Incident 2026-06-29: RAW description write paths (identify-v4 mobile_snippet,
 * grounding pipeline, batch-optimize verbatim copy) bypass the per-call
 * sanitizers, so a literal backslash-n from an over-escaping LLM could still
 * reach Firestore. This guard runs inside firestore.js saveProduct() right
 * before the write, so NO writer — current or future — can persist a literal
 * escape in any description-bearing field, and already-stored corruption
 * self-heals on the next save.
 *
 * NOTE: the JS literal '\\n' in this file is the two characters backslash + n.
 */
const { deLiteralizeProductTextFields } = require('../../lib/listing-sanitize');

const LIT = '\\n';

describe('deLiteralizeProductTextFields', () => {
  it('de-literalizes details.short_description and details.description', () => {
    const out = deLiteralizeProductTextFields({
      details: {
        short_description: 'Erster Teil.\\n\\n \\n Zweiter Teil mit Pin.',
        description: 'Kaufland Text\\nmit Umbruch.',
      },
    });
    expect(out.details.short_description).not.toContain(LIT);
    expect(out.details.description).not.toContain(LIT);
    expect(out.details.short_description).toContain('Zweiter Teil mit Pin');
    expect(out.details.description).toContain('mit Umbruch');
  });

  it('de-literalizes every string item of details.key_features', () => {
    const out = deLiteralizeProductTextFields({
      details: { key_features: ['Sauber', 'Mit\\nUmbruch im Highlight', '\\n\\nfuehrender Umbruch'] },
    });
    expect(out.details.key_features.join(' ')).not.toContain(LIT);
    expect(out.details.key_features.length).toBe(3);
  });

  it('de-literalizes marketplace.ebay/kaufland description + mobile_snippet', () => {
    const out = deLiteralizeProductTextFields({
      marketplace: {
        ebay: { description: 'eBay\\nText', mobile_snippet: 'Snippet\\nhier' },
        kaufland: { description: 'Kaufland\\n\\nText' },
      },
    });
    expect(out.marketplace.ebay.description).not.toContain(LIT);
    expect(out.marketplace.ebay.mobile_snippet).not.toContain(LIT);
    expect(out.marketplace.kaufland.description).not.toContain(LIT);
  });

  it('does NOT mutate the input object (pure)', () => {
    const input = { details: { short_description: 'A\\nB' } };
    const out = deLiteralizeProductTextFields(input);
    expect(input.details.short_description).toBe('A\\nB'); // original untouched
    expect(out.details.short_description).not.toContain(LIT);
    expect(out).not.toBe(input);
  });

  it('leaves clean fields and unrelated fields untouched', () => {
    const out = deLiteralizeProductTextFields({
      id: 'p1',
      identification: { name: 'Titel ohne Escapes', sku: 'SKU-1' },
      details: { short_description: 'Schon sauber.', key_features: [] },
      inventory: { quantity: 5 },
    });
    expect(out.id).toBe('p1');
    expect(out.identification.sku).toBe('SKU-1');
    expect(out.inventory).toEqual({ quantity: 5 });
    expect(out.details.short_description).toBe('Schon sauber.');
  });

  it('is robust to missing/non-object/non-string fields', () => {
    expect(deLiteralizeProductTextFields(null)).toBe(null);
    expect(deLiteralizeProductTextFields(undefined)).toBe(undefined);
    expect(() => deLiteralizeProductTextFields({})).not.toThrow();
    const out = deLiteralizeProductTextFields({ details: { short_description: 42, key_features: 'nope' } });
    expect(out.details.short_description).toBe(42);
    expect(out.details.key_features).toBe('nope');
  });
});
