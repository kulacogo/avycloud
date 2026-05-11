'use strict';

// Vitest CJS; globals enabled (describe/it/expect).
//
// Tests fuer backend/lib/cassini-category-map.js — Mapping eBay-L1-Categories
// auf 9 Cassini-Buckets + Title-Pattern-Lookup pro Bucket.

const {
  getCassiniCategoryBucket,
  getCategoryPattern,
  _internal,
} = require('../../lib/cassini-category-map');

describe('cassini-category-map', () => {
  describe('getCassiniCategoryBucket — exact L1 ID matches', () => {
    it('returns fashion for ebay-categoryId 11450 (Kleidung & Accessoires)', () => {
      expect(getCassiniCategoryBucket('11450')).toBe('fashion');
    });

    it('returns electronics for 15032 (Handy & Smartphones)', () => {
      expect(getCassiniCategoryBucket('15032')).toBe('electronics');
    });

    it('returns home_garden for 11700 (Moebel & Wohnen)', () => {
      expect(getCassiniCategoryBucket('11700')).toBe('home_garden');
    });

    it('returns motors for 9800 (Auto & Motorrad: Teile)', () => {
      expect(getCassiniCategoryBucket('9800')).toBe('motors');
    });

    it('returns toys for 220 (Spielzeug)', () => {
      expect(getCassiniCategoryBucket('220')).toBe('toys');
    });

    it('returns books_music_films for 267 (Buecher)', () => {
      expect(getCassiniCategoryBucket('267')).toBe('books_music_films');
    });

    it('returns business_industrial for 12576 (Business & Industrie)', () => {
      expect(getCassiniCategoryBucket('12576')).toBe('business_industrial');
    });

    it('returns hobby_sport for 888 (Sport)', () => {
      expect(getCassiniCategoryBucket('888')).toBe('hobby_sport');
    });

    it('returns collectibles for 20121 (Sammeln & Seltenes)', () => {
      expect(getCassiniCategoryBucket('20121')).toBe('collectibles');
    });
  });

  describe('getCassiniCategoryBucket — numeric id input', () => {
    it('accepts plain number 11450 (auto-stringification)', () => {
      expect(getCassiniCategoryBucket(11450)).toBe('fashion');
    });
  });

  describe('getCassiniCategoryBucket — breadcrumb keyword fallback', () => {
    it("returns 'fashion' for breadcrumb 'Damenmode > Kleider'", () => {
      expect(getCassiniCategoryBucket(null, 'Damenmode > Kleider')).toBe('fashion');
    });

    it("returns 'electronics' for breadcrumb containing 'Handy & Tablet'", () => {
      expect(getCassiniCategoryBucket(null, 'Handy & Tablet > Smartphone')).toBe('electronics');
    });

    it("returns 'motors' for breadcrumb 'Auto & Motorrad: Teile > Bremsen'", () => {
      expect(getCassiniCategoryBucket(null, 'Auto & Motorrad: Teile > Bremsen')).toBe('motors');
    });

    it("returns 'home_garden' for breadcrumb 'Moebel > Esstische'", () => {
      expect(getCassiniCategoryBucket(null, 'Moebel > Esstische')).toBe('home_garden');
    });

    it("returns 'collectibles' for breadcrumb containing 'Trading Cards'", () => {
      expect(getCassiniCategoryBucket(null, 'Sammeln > Trading Cards > Pokemon')).toBe('collectibles');
    });

    it('accepts breadcrumb as array', () => {
      expect(getCassiniCategoryBucket(null, ['Damenmode', 'Jeans', 'Slim'])).toBe('fashion');
    });
  });

  describe('getCassiniCategoryBucket — sub-category prefix fallback', () => {
    it('returns fashion for sub-id 11450123 (prefix match on 11450)', () => {
      expect(getCassiniCategoryBucket('11450123')).toBe('fashion');
    });
  });

  describe('getCassiniCategoryBucket — default fallback', () => {
    it("returns 'default' when both id and breadcrumb are unknown", () => {
      expect(getCassiniCategoryBucket('99999999', 'Unknown > Random > Stuff')).toBe('default');
    });

    it("returns 'default' on null/null input", () => {
      expect(getCassiniCategoryBucket(null, null)).toBe('default');
    });

    it("returns 'default' on empty-string input", () => {
      expect(getCassiniCategoryBucket('', '')).toBe('default');
    });

    it("returns 'default' on undefined input", () => {
      expect(getCassiniCategoryBucket(undefined, undefined)).toBe('default');
    });
  });

  describe('getCategoryPattern — returns pattern strings for each bucket', () => {
    it('fashion pattern contains [Marke] and [Material]', () => {
      const p = getCategoryPattern('fashion');
      expect(p).toContain('[Marke]');
      expect(p).toContain('[Material]');
    });

    it('electronics pattern contains [Modellnummer/MPN]', () => {
      expect(getCategoryPattern('electronics')).toContain('[Modellnummer/MPN]');
    });

    it('home_garden pattern contains [Material] and [Maße/Groesse]', () => {
      const p = getCategoryPattern('home_garden');
      expect(p).toContain('[Material]');
      expect(p).toContain('[Maße/Groesse]');
    });

    it('motors pattern contains [OEM/OES-Referenznummer]', () => {
      expect(getCategoryPattern('motors')).toContain('[OEM/OES-Referenznummer]');
    });

    it('collectibles pattern contains [Jahr/Epoche] and [Zustand/Grading]', () => {
      const p = getCategoryPattern('collectibles');
      expect(p).toContain('[Jahr/Epoche]');
      expect(p).toContain('[Zustand/Grading]');
    });

    it('toys pattern contains [Set-Nummer]', () => {
      expect(getCategoryPattern('toys')).toContain('[Set-Nummer]');
    });

    it('books_music_films pattern contains [Format/Medium]', () => {
      expect(getCategoryPattern('books_music_films')).toContain('[Format/Medium]');
    });

    it('business_industrial pattern contains [Herstellernummer/MPN]', () => {
      expect(getCategoryPattern('business_industrial')).toContain('[Herstellernummer/MPN]');
    });

    it('hobby_sport pattern contains [Sportart/Aktivitaet]', () => {
      expect(getCategoryPattern('hobby_sport')).toContain('[Sportart/Aktivitaet]');
    });

    it('default pattern is a non-empty string when called with unknown bucket', () => {
      const p = getCategoryPattern('unknown-bucket');
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(0);
      expect(p).toContain('[Marke]');
    });

    it("default pattern is returned when called with 'default'", () => {
      const p = getCategoryPattern('default');
      expect(p).toContain('[Marke]');
      expect(p).toContain('[Modell]');
    });

    it('returns string for every bucket in VALID_BUCKETS', () => {
      for (const bucket of _internal.VALID_BUCKETS) {
        const p = getCategoryPattern(bucket);
        expect(typeof p).toBe('string');
        expect(p.length).toBeGreaterThan(0);
      }
    });
  });

  describe('_internal — exposed for seed-scripts', () => {
    it('VALID_BUCKETS contains exactly 10 entries (9 buckets + default)', () => {
      expect(_internal.VALID_BUCKETS.size).toBe(10);
    });

    it('PATTERNS has an entry for every valid bucket', () => {
      for (const bucket of _internal.VALID_BUCKETS) {
        expect(_internal.PATTERNS).toHaveProperty(bucket);
      }
    });

    it('L1_BUCKET_MAP maps every value to a known bucket', () => {
      for (const bucket of Object.values(_internal.L1_BUCKET_MAP)) {
        expect(_internal.VALID_BUCKETS.has(bucket)).toBe(true);
      }
    });

    it('BREADCRUMB_KEYWORDS rows all reference a known bucket', () => {
      for (const row of _internal.BREADCRUMB_KEYWORDS) {
        expect(_internal.VALID_BUCKETS.has(row.bucket)).toBe(true);
        expect(Array.isArray(row.keywords)).toBe(true);
        expect(row.keywords.length).toBeGreaterThan(0);
      }
    });
  });
});
