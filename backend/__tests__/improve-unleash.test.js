/**
 * Tests for "Unleash Gemini" Improve enhancements:
 * - buildImprovePromptExtension()
 * - mobile_snippet in FULL_PRODUCT_SCHEMA
 * - buildCommonPolicyText context parameter
 * - Keyword-density + benefits warn checks in rulebook
 */

const { buildImprovePromptExtension, FULL_PRODUCT_SCHEMA } = require('../lib/gemini3-client');
const { buildCommonPolicyText } = require('../lib/llm-policy-pack');

// ─── buildImprovePromptExtension ───

describe('buildImprovePromptExtension', () => {
  it('generates prompt with title insights and existing product', () => {
    const ctx = {
      existingProduct: {
        identification: { name: 'Anker PowerCore 10000', brand: 'Anker' },
        details: {
          categoryPath: 'Elektronik > Ladegeraete',
          identifiers: { ean: '0194644170721', mpn: 'A1263' },
        },
      },
      titleInsights: {
        sampleTitles: [
          'Anker PowerCore 10000mAh Powerbank USB-C Schnellladung',
          'Anker Portable Charger 10000mAh Ultra Compact',
        ],
        topTokens: ['powerbank', 'usb-c', 'schnellladung', '10000mah'],
      },
    };

    const result = buildImprovePromptExtension(ctx);

    // Product context
    expect(result).toContain('Aktueller Titel: Anker PowerCore 10000');
    expect(result).toContain('Marke: Anker');
    expect(result).toContain('EAN: 0194644170721');
    expect(result).toContain('MPN: A1263');

    // Competitor titles
    expect(result).toContain('WETTBEWERBER-TITEL AUF EBAY');
    expect(result).toContain('Anker PowerCore 10000mAh Powerbank USB-C Schnellladung');

    // Top keywords
    expect(result).toContain('TOP-KEYWORDS DIESER KATEGORIE AUF EBAY: powerbank, usb-c, schnellladung, 10000mah');

    // Cassini instructions
    expect(result).toContain('CASSINI-OPTIMIERUNG');
    expect(result).toContain('CTR-kritisch');
    expect(result).toContain('Long-Tail-Keywords');
    expect(result).toContain('KEYWORD-DICHTE');
    expect(result).toContain('Benefits-Format');

    // Mobile snippet instruction
    expect(result).toContain('MOBILE SNIPPET');
    expect(result).toContain('max 800 Zeichen');
    expect(result).toContain('Schema.org');
  });

  it('returns Cassini instructions even without title insights', () => {
    const ctx = {
      existingProduct: null,
      titleInsights: null,
    };

    const result = buildImprovePromptExtension(ctx);

    // Should still have Cassini instructions
    expect(result).toContain('CASSINI-OPTIMIERUNG');
    expect(result).toContain('MOBILE SNIPPET');

    // Should NOT have product/insight blocks
    expect(result).not.toContain('BESTEHENDE PRODUKTDATEN');
    expect(result).not.toContain('WETTBEWERBER-TITEL');
    expect(result).not.toContain('TOP-KEYWORDS');
  });

  it('handles empty titleInsights arrays gracefully', () => {
    const ctx = {
      existingProduct: { identification: { name: 'Test' } },
      titleInsights: { sampleTitles: [], topTokens: [] },
    };

    const result = buildImprovePromptExtension(ctx);
    expect(result).toContain('Aktueller Titel: Test');
    expect(result).not.toContain('WETTBEWERBER-TITEL');
    expect(result).not.toContain('TOP-KEYWORDS DIESER KATEGORIE');
  });
});

// ─── FULL_PRODUCT_SCHEMA ───

describe('FULL_PRODUCT_SCHEMA', () => {
  it('includes mobile_snippet field', () => {
    expect(FULL_PRODUCT_SCHEMA.properties.mobile_snippet).toBeDefined();
    expect(FULL_PRODUCT_SCHEMA.properties.mobile_snippet.type).toBe('string');
    expect(FULL_PRODUCT_SCHEMA.properties.mobile_snippet.description).toContain('800');
  });
});

// ─── buildCommonPolicyText context parameter ───

describe('buildCommonPolicyText context parameter', () => {
  it('default (identify) uses restrictive keyword rules', () => {
    const text = buildCommonPolicyText({ locale: 'de-DE' });
    // Default should have the restrictive natural keyword rule
    expect(text).toContain('Keyword-Verteilung');
    // Should NOT contain the improve-specific density target
    expect(text).not.toContain('5-7%');
  });

  it('context=improve uses expanded keyword rules', () => {
    const text = buildCommonPolicyText({ locale: 'de-DE', context: 'improve' });
    expect(text).toContain('5-7%');
    expect(text).toContain('Synonyme');
  });

  it('context=listing uses expanded keyword rules', () => {
    const text = buildCommonPolicyText({ locale: 'de-DE', context: 'listing' });
    expect(text).toContain('5-7%');
  });
});

// ─── Keyword-Density and Benefits checks in rulebook ───

describe('Rulebook warn checks', () => {
  // We test normalizeProductForPolicyApply directly
  const { normalizeProductForPolicyApply } = require('../lib/llm-rulebook');

  it('warns when keyword density is too low', () => {
    // Build a product with long description but no keyword overlap with title
    const product = {
      identification: { name: 'Anker PowerCore 10000mAh Powerbank USB-C', brand: 'Anker' },
      details: {
        short_description: '<p>' + 'Lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(10) + '</p>',
        key_features: ['Feature eins – Vorteil', 'Feature zwei – Vorteil', 'Feature drei – Vorteil'],
        attributes: {},
      },
    };

    const result = normalizeProductForPolicyApply(product, { source: 'test' });
    const densityIssue = result.issues.find(i => i.includes('keyword-density'));
    expect(densityIssue).toBeDefined();
    expect(densityIssue).toContain('niedrig');
  });

  it('does NOT warn when description has good keyword density', () => {
    // Description that repeats title keywords naturally
    const words = [];
    for (let i = 0; i < 20; i++) {
      words.push('Die Powerbank von Anker bietet PowerCore Technologie mit USB-C Schnellladung und 10000mAh Kapazitaet.');
    }
    const product = {
      identification: { name: 'Anker PowerCore 10000mAh Powerbank USB-C', brand: 'Anker' },
      details: {
        short_description: '<p>' + words.join(' ') + '</p>',
        key_features: ['Schnellladung – USB-C Power Delivery', 'Kompakt – passt in jede Tasche', '10000mAh – laedt Smartphone 3x'],
        attributes: {},
      },
    };

    const result = normalizeProductForPolicyApply(product, { source: 'test' });
    const densityIssue = result.issues.find(i => i.includes('keyword-density'));
    expect(densityIssue).toBeUndefined();
  });

  it('warns when highlights lack benefits format', () => {
    const product = {
      identification: { name: 'Test Product', brand: 'Brand' },
      details: {
        short_description: '',
        key_features: [
          '512GB SSD',
          'Intel Core i7',
          '16GB RAM',
          'HDMI 2.1',
          'WiFi 6E',
        ],
        attributes: {},
      },
    };

    const result = normalizeProductForPolicyApply(product, { source: 'test' });
    const benefitsIssue = result.issues.find(i => i.includes('benefits-format'));
    expect(benefitsIssue).toBeDefined();
    expect(benefitsIssue).toContain('0/5');
  });

  it('does NOT warn when highlights have enough benefits', () => {
    const product = {
      identification: { name: 'Test Product', brand: 'Brand' },
      details: {
        short_description: '',
        key_features: [
          '512GB SSD – genug Platz fuer Ihre Mediathek',
          'Intel Core i7 – rasante Performance fuer jede Aufgabe',
          '16GB RAM – flüssiges Multitasking damit alles laeuft',
        ],
        attributes: {},
      },
    };

    const result = normalizeProductForPolicyApply(product, { source: 'test' });
    const benefitsIssue = result.issues.find(i => i.includes('benefits-format'));
    expect(benefitsIssue).toBeUndefined();
  });

  it('keyword-density and benefits checks are warn-only (ok stays true)', () => {
    const product = {
      identification: { name: 'Anker PowerCore 10000mAh Powerbank', brand: 'Anker' },
      details: {
        short_description: '<p>' + 'Lorem ipsum dolor sit amet '.repeat(20) + '</p>',
        key_features: ['Feature A', 'Feature B', 'Feature C'],
        attributes: {},
      },
    };

    const result = normalizeProductForPolicyApply(product, { source: 'test' });
    // Even with warnings, ok should be true (best-effort)
    expect(result.ok).toBe(true);
  });
});
