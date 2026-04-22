'use strict';

const {
  HTML_DESCRIPTION_TEMPLATE,
  buildEbayDescription,
  computeKeywordDensity,
  _internal,
} = require('../../lib/seo-description-builder');

describe('seo-description-builder', () => {
  describe('constants', () => {
    it('template defines 5 sections in deterministic order', () => {
      expect(HTML_DESCRIPTION_TEMPLATE.sections).toEqual([
        'hero', 'features', 'specs', 'condition', 'gpsr',
      ]);
    });
  });

  describe('_internal.escapeHtml', () => {
    it('escapes &, <, >, quotes', () => {
      expect(_internal.escapeHtml('<script>"x"</script>')).toContain('&lt;script&gt;');
      expect(_internal.escapeHtml('Sony & Philips')).toContain('&amp;');
    });

    it('returns empty for null/undefined', () => {
      expect(_internal.escapeHtml(null)).toBe('');
      expect(_internal.escapeHtml(undefined)).toBe('');
    });
  });

  describe('_internal.tokenize', () => {
    it('strips HTML tags + diacritics + punctuation, ß→ss', () => {
      expect(_internal.tokenize('<p>Größe Straße</p>')).toEqual(['grosse', 'strasse']);
    });

    it('drops single-char tokens', () => {
      expect(_internal.tokenize('a bc def')).toEqual(['bc', 'def']);
    });
  });

  describe('_internal.buildHeroSection', () => {
    it('builds hero from shortDescription when provided', () => {
      const out = _internal.buildHeroSection({ shortDescription: 'Premium Kopfhörer' });
      expect(out).toContain('<section class="hero">');
      expect(out).toContain('Premium Kopfhörer');
    });

    it('falls back to brand + productType + title composition', () => {
      const out = _internal.buildHeroSection({
        brand: 'Sony',
        productType: 'Kopfhörer',
        title: 'WH-1000XM5',
      });
      expect(out).toContain('Sony');
      expect(out).toContain('WH-1000XM5');
    });

    it('returns empty when nothing provided', () => {
      expect(_internal.buildHeroSection({})).toBe('');
    });
  });

  describe('_internal.buildFeaturesSection', () => {
    it('builds <ul><li> list from features', () => {
      const out = _internal.buildFeaturesSection(['30h Akkulaufzeit', 'Noise Cancelling']);
      expect(out).toContain('<ul>');
      expect(out).toContain('<li>30h Akkulaufzeit</li>');
      expect(out).toContain('<li>Noise Cancelling</li>');
    });

    it('caps at 12 features', () => {
      const features = Array.from({ length: 20 }, (_, i) => `Feature ${i}`);
      const out = _internal.buildFeaturesSection(features);
      const matches = out.match(/<li>/g) || [];
      expect(matches.length).toBe(12);
    });

    it('returns empty for empty array', () => {
      expect(_internal.buildFeaturesSection([])).toBe('');
    });
  });

  describe('_internal.buildSpecsSection', () => {
    it('builds <table><tr><th><td> from aspect list', () => {
      const out = _internal.buildSpecsSection([
        { key: 'Marke', value: 'Sony' },
        { key: 'Farbe', value: 'Schwarz' },
      ]);
      expect(out).toContain('<table>');
      expect(out).toContain('<th>Marke</th>');
      expect(out).toContain('<td>Schwarz</td>');
    });

    it('accepts record input {key: value}', () => {
      const out = _internal.buildSpecsSection({ Marke: 'Sony' });
      expect(out).toContain('<th>Marke</th>');
      expect(out).toContain('<td>Sony</td>');
    });

    it('drops rows with missing key or value', () => {
      const out = _internal.buildSpecsSection([
        { key: 'Marke', value: 'Sony' },
        { key: '', value: 'x' },
        { key: 'Farbe', value: '' },
      ]);
      const matches = out.match(/<tr>/g) || [];
      expect(matches.length).toBe(1);
    });
  });

  describe('_internal.buildGpsrSection', () => {
    it('renders manufacturer + address + email when all present', () => {
      const out = _internal.buildGpsrSection({
        manufacturer_name: 'Sony Deutschland',
        manufacturer_address: 'Musterstr. 1, 80331 München',
        email: 'compliance@sony.de',
      });
      expect(out).toContain('Sony Deutschland');
      expect(out).toContain('Musterstr');
      expect(out).toContain('compliance@sony.de');
    });

    it('returns empty when no GPSR data', () => {
      expect(_internal.buildGpsrSection({})).toBe('');
    });
  });

  describe('computeKeywordDensity', () => {
    it('computes density as occurrence/total_tokens', () => {
      const html = '<p>Sony Kopfhörer mit Bluetooth und Noise Cancelling. Sony Bluetooth Premium.</p>';
      const res = computeKeywordDensity(html, ['sony', 'bluetooth']);
      expect(res.perKeyword.sony).toBeGreaterThan(0);
      expect(res.perKeyword.bluetooth).toBeGreaterThan(0);
      expect(res.overall).toBeGreaterThan(0);
      expect(res.totalTokens).toBeGreaterThan(5);
    });

    it('overall aggregates per-keyword densities', () => {
      const html = '<p>alpha beta gamma alpha</p>';
      const res = computeKeywordDensity(html, ['alpha', 'beta']);
      expect(res.overall).toBeCloseTo(res.perKeyword.alpha + res.perKeyword.beta, 3);
    });

    it('returns zero for empty content', () => {
      expect(computeKeywordDensity('', ['foo']).overall).toBe(0);
    });

    it('ignores stopwords as keywords', () => {
      const res = computeKeywordDensity('der die das', ['der', 'die']);
      expect(res.overall).toBe(0);
    });
  });

  describe('buildEbayDescription', () => {
    it('produces HTML with all 5 sections when data is complete', () => {
      const res = buildEbayDescription({
        productData: {
          brand: 'Sony',
          title: 'WH-1000XM5 Wireless Over-Ear',
          productType: 'Kopfhörer',
          short_description: 'Premium Wireless Kopfhörer mit Noise Cancelling.',
          condition: 'Neu',
        },
        keyFeatures: ['30h Akku', 'Multipoint Bluetooth', 'Hi-Res Audio'],
        aspects: [
          { key: 'Marke', value: 'Sony' },
          { key: 'Modell', value: 'WH-1000XM5' },
          { key: 'Farbe', value: 'Schwarz' },
        ],
        gpsr: {
          manufacturer_name: 'Sony Europe BV',
          manufacturer_address: 'Hedelfinger Str. 61, 70327 Stuttgart',
          email: 'contact@sony.de',
        },
      });
      expect(res.sectionsPresent).toContain('hero');
      expect(res.sectionsPresent).toContain('features');
      expect(res.sectionsPresent).toContain('specs');
      expect(res.sectionsPresent).toContain('condition');
      expect(res.sectionsPresent).toContain('gpsr');
      expect(res.length).toBeGreaterThan(300);
    });

    it('warns when hero/features/gpsr missing', () => {
      const res = buildEbayDescription({
        productData: {},
        keyFeatures: [],
        aspects: [],
        gpsr: {},
      });
      expect(res.warnings).toContain('missing_hero');
      expect(res.warnings).toContain('missing_features');
      expect(res.warnings).toContain('missing_gpsr');
    });

    it('computes keyword density from final HTML', () => {
      const res = buildEbayDescription({
        productData: { brand: 'Sony', productType: 'Kopfhörer Bluetooth Premium Wireless' },
        keyFeatures: ['Bluetooth 5.2 Wireless Noise Cancelling'],
        aspects: [{ key: 'Marke', value: 'Sony' }],
        gpsr: { manufacturer_name: 'Sony Europe BV' },
        seoKeywords: ['sony', 'bluetooth'],
      });
      expect(res.keywordDensity.perKeyword.sony).toBeGreaterThan(0);
      expect(res.keywordDensity.perKeyword.bluetooth).toBeGreaterThan(0);
    });

    it('flags low keyword density when seoKeywords unused', () => {
      const res = buildEbayDescription({
        productData: { brand: 'Sony', productType: 'Kopfhörer' },
        keyFeatures: ['Features here'],
        aspects: [{ key: 'Marke', value: 'Sony' }],
        gpsr: { manufacturer_name: 'Sony Europe BV' },
        seoKeywords: ['totallyunrelatedkeywordzz', 'anotherabsentone'],
      });
      expect(res.warnings).toContain('low_keyword_density');
    });

    it('respects maxLen option (via sanitizeDescriptionToHtml)', () => {
      const longFeatures = Array.from({ length: 100 }, (_, i) => `Feature ${i} with very long text`);
      const res = buildEbayDescription({
        productData: { brand: 'Sony', productType: 'Kopfhörer' },
        keyFeatures: longFeatures,
        aspects: [],
        gpsr: {},
        maxLen: 500,
      });
      // sanitizeDescriptionToHtml has hardMax=max(500, maxLen), so length should be bounded
      expect(res.length).toBeLessThanOrEqual(3000);
    });
  });
});
