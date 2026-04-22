'use strict';

const {
  EBAY_TITLE_MAX,
  KAUFLAND_TITLE_MAX,
  MOBILE_FIRST_WINDOW,
  EBAY_TITLE_SCHEMA,
  buildEbayTitle,
  scoreTitleQuality,
  pickBestKeywords,
  _internal,
} = require('../../lib/seo-title-builder');

describe('seo-title-builder', () => {
  describe('constants', () => {
    it('exposes correct max lengths', () => {
      expect(EBAY_TITLE_MAX).toBe(80);
      expect(KAUFLAND_TITLE_MAX).toBe(150);
      expect(MOBILE_FIRST_WINDOW).toBe(65);
    });

    it('schema order starts with brand, ends with condition', () => {
      expect(EBAY_TITLE_SCHEMA[0]).toBe('brand');
      expect(EBAY_TITLE_SCHEMA[EBAY_TITLE_SCHEMA.length - 1]).toBe('condition');
    });
  });

  describe('_internal.tokenize', () => {
    it('lowercases + strips diacritics + punctuation', () => {
      expect(_internal.tokenize('Sony Wireless Über-Kopfhörer')).toEqual([
        'sony', 'wireless', 'uber', 'kopfhorer',
      ]);
    });

    it('normalizes ß to ss', () => {
      expect(_internal.tokenize('Straße')).toEqual(['strasse']);
    });

    it('returns [] for empty / non-string', () => {
      expect(_internal.tokenize(null)).toEqual([]);
      expect(_internal.tokenize('')).toEqual([]);
    });
  });

  describe('_internal.nonStopTokens', () => {
    it('filters stopwords', () => {
      expect(_internal.nonStopTokens('das Handy mit dem top Display'))
        .toEqual(['handy', 'display']);
    });
  });

  describe('_internal.composeFromSchema', () => {
    it('joins schema parts in order', () => {
      const out = _internal.composeFromSchema({
        brand: 'Sony',
        productType: 'Kopfhörer',
        model: 'WH-1000XM5',
        keySpec: 'Bluetooth',
      });
      expect(out).toBe('Sony Kopfhörer WH-1000XM5 Bluetooth');
    });

    it('drops empty parts', () => {
      const out = _internal.composeFromSchema({
        brand: 'Sony',
        model: '',
        keySpec: 'Bluetooth',
      });
      expect(out).toBe('Sony Bluetooth');
    });
  });

  describe('_internal.safeTruncate', () => {
    it('no truncation if already short enough', () => {
      expect(_internal.safeTruncate('Sony WH-1000XM5', 80)).toBe('Sony WH-1000XM5');
    });

    it('truncates at word boundary when possible', () => {
      const long = 'Sony WH-1000XM5 Wireless Noise Cancelling Over-Ear Kopfhörer Bluetooth Schwarz Neu';
      const out = _internal.safeTruncate(long, 50);
      expect(out.length).toBeLessThanOrEqual(50);
      expect(out.endsWith(' ')).toBe(false);
    });
  });

  describe('_internal.stripBadPrefixes', () => {
    it('removes marketing prefixes like "NEU:" and "TOP:"', () => {
      expect(_internal.stripBadPrefixes('NEU: Sony WH-1000XM5')).toBe('Sony WH-1000XM5');
      expect(_internal.stripBadPrefixes('TOP Angebot Philips TV')).toBe('Philips TV');
    });
  });

  describe('pickBestKeywords', () => {
    it('picks top-N keywords not already in existing text', () => {
      const kws = pickBestKeywords(
        [
          { token: 'bluetooth', coverage: 0.8 },
          { token: 'sony', coverage: 0.7 },    // already in existing
          { token: 'wireless', coverage: 0.6 },
          { token: 'noise', coverage: 0.5 },
        ],
        'Sony WH-1000XM5',
        2
      );
      expect(kws).toEqual(['bluetooth', 'wireless']);
    });

    it('accepts plain-string keyword lists', () => {
      const kws = pickBestKeywords(['bluetooth', 'wireless'], '', 2);
      expect(kws).toEqual(['bluetooth', 'wireless']);
    });

    it('filters stopwords', () => {
      const kws = pickBestKeywords(['der', 'die', 'bluetooth'], '', 5);
      expect(kws).toEqual(['bluetooth']);
    });

    it('returns [] for non-array input', () => {
      expect(pickBestKeywords(null, '')).toEqual([]);
    });
  });

  describe('buildEbayTitle', () => {
    it('composes a valid ≤80 char title from schema parts', () => {
      const result = buildEbayTitle({
        brand: 'Sony',
        productType: 'Kopfhörer',
        model: 'WH-1000XM5',
        differentiator: 'Wireless',
        keySpec: 'Bluetooth',
        condition: 'Neu',
      });
      expect(result.chars).toBeLessThanOrEqual(80);
      expect(result.title.toLowerCase()).toContain('sony');
      expect(result.title.toLowerCase()).toContain('wh-1000xm5');
    });

    it('applies kaufland max when marketplace=KAUFLAND_DE', () => {
      const result = buildEbayTitle(
        {
          brand: 'Sony',
          productType: 'Over-Ear Wireless Noise Cancelling Bluetooth Premium Studio',
          model: 'WH-1000XM5',
          differentiator: 'Kopfhörer mit 30h Akkulaufzeit und Multipoint-Pairing Schwarz',
          keySpec: 'Hi-Res Audio LDAC',
          condition: 'Neuware',
        },
        { marketplace: 'KAUFLAND_DE' }
      );
      expect(result.chars).toBeGreaterThan(80);
      expect(result.chars).toBeLessThanOrEqual(150);
    });

    it('injects competitor keywords when space permits', () => {
      const result = buildEbayTitle({
        brand: 'Sony',
        model: 'WH-1000XM5',
        competitorKeywords: [
          { token: 'noise', coverage: 0.9 },
          { token: 'cancelling', coverage: 0.85 },
        ],
      });
      expect(result.injectedKeywords.length).toBeGreaterThan(0);
      expect(result.title.toLowerCase()).toMatch(/noise|cancelling/);
    });

    it('does not inject keywords that would exceed maxLen', () => {
      const result = buildEbayTitle({
        brand: 'Sony',
        productType: 'Kopfhörer Over-Ear Wireless Noise Cancelling Bluetooth',
        model: 'WH-1000XM5 Premium Edition Limited',
        competitorKeywords: [
          { token: 'extralongkeywordthatshouldnotfit', coverage: 1 },
        ],
      });
      expect(result.chars).toBeLessThanOrEqual(80);
    });

    it('returns mobilePreview of first 65 chars', () => {
      const result = buildEbayTitle({
        brand: 'Sony',
        productType: 'Wireless Noise Cancelling Kopfhörer',
        model: 'WH-1000XM5',
      });
      expect(result.mobilePreview.length).toBeLessThanOrEqual(65);
      expect(result.title.startsWith(result.mobilePreview)).toBe(true);
    });

    it('warns when brand is missing', () => {
      const result = buildEbayTitle({
        productType: 'Kopfhörer',
        model: 'WH-1000XM5',
      });
      expect(result.warnings).toContain('missing_brand');
    });

    it('warns when both model and product-type are missing', () => {
      const result = buildEbayTitle({ brand: 'Sony' });
      expect(result.warnings).toContain('missing_model_and_product_type');
    });

    it('strips bad marketing prefixes', () => {
      const result = buildEbayTitle({
        brand: 'NEU: Sony',
        productType: 'Kopfhörer',
        model: 'WH-1000XM5',
      });
      // coerceTitleToPolicy may further normalize, but "NEU:" should be gone
      expect(result.title.toLowerCase()).not.toMatch(/^neu:/);
    });
  });

  describe('scoreTitleQuality', () => {
    it('mobileCoverage 1 when brand + model both in first window', () => {
      const score = scoreTitleQuality('Sony WH-1000XM5 Kopfhörer Noise Cancelling', {
        brand: 'Sony',
        model: 'WH-1000XM5',
      });
      expect(score.mobileCoverage).toBeGreaterThanOrEqual(0.9);
    });

    it('mobileCoverage drops when brand not in first window', () => {
      const padded = 'Kopfhörer Premium Hochwertig Edel Erstklassig Luxus Neu Sony';
      const score = scoreTitleQuality(padded, { brand: 'Sony' });
      expect(score.mobileCoverage).toBeLessThan(0.6);
    });

    it('keywordMatch reflects Jaccard overlap with competitor set', () => {
      const score = scoreTitleQuality('Sony WH-1000XM5 Noise Cancelling Bluetooth', {
        brand: 'Sony',
        competitorKeywords: ['noise', 'cancelling', 'bluetooth', 'wireless'],
      });
      expect(score.keywordMatch).toBeGreaterThanOrEqual(0.7);
    });

    it('penalizes all-caps runs + short titles', () => {
      const score = scoreTitleQuality('SONY KOPFHÖRER TOP', { brand: 'SONY' });
      expect(score.readability).toBeLessThan(1);
    });

    it('returns zero scores for empty title', () => {
      const score = scoreTitleQuality('', {});
      expect(score).toEqual({ overall: 0, mobileCoverage: 0, keywordMatch: 0, readability: 0 });
    });

    it('overall is weighted combination (mobile 0.5 + keyword 0.3 + readability 0.2)', () => {
      const score = scoreTitleQuality('Sony WH-1000XM5 Kopfhörer', {
        brand: 'Sony',
        model: 'WH-1000XM5',
      });
      const expected = score.mobileCoverage * 0.5 + score.keywordMatch * 0.3 + score.readability * 0.2;
      expect(score.overall).toBeCloseTo(Math.round(expected * 100) / 100, 2);
    });
  });
});
