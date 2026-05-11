'use strict';

/**
 * Tests for lib/cassini-scorer.js
 *
 * Pure-library tests, no Firestore/GCP needed. We patch
 * `lib/datasheet-quality.js` via `require.cache` (CJS-pattern from CLAUDE.md)
 * so we can verify the defensive-fallback path independent of the underlying
 * quality library.
 */

const path = require('path');

const datasheetQualityPath = require.resolve('../../lib/datasheet-quality');
let originalEvaluateEbayReady;

beforeAll(() => {
  // Force-load datasheet-quality so we can patch its exports.
  const mod = require('../../lib/datasheet-quality');
  originalEvaluateEbayReady = mod.evaluateEbayReady;
});

afterEach(() => {
  // Restore the real function after each test.
  const cached = require.cache[datasheetQualityPath];
  if (cached && cached.exports) {
    cached.exports.evaluateEbayReady = originalEvaluateEbayReady;
  }
});

// Force a fresh require of cassini-scorer for each describe-block in case
// individual tests need to reset module state.
function loadScorer() {
  delete require.cache[require.resolve('../../lib/cassini-scorer')];
  return require('../../lib/cassini-scorer');
}

function makeProduct(overrides = {}) {
  // Minimal "ready" product baseline so individual tests can override one
  // dimension at a time.
  const base = {
    identification: {
      name: 'Sony WH-1000XM5 Wireless Bluetooth Kopfhörer Noise Cancelling Schwarz Neu OVP',
      brand: 'Sony',
      gtin: '4548736134322',
    },
    details: {
      short_description: '',
      // ~200-word description placeholder; tests override per-case.
      description: '',
      categoryId: '15052',
      images: [
        {
          url: 'https://example.com/img1.jpg',
          width: 1200,
          height: 1200,
          backgroundScore: 0.92,
        },
        { url: 'https://example.com/img2.jpg', width: 1000, height: 1000, backgroundScore: 0.88 },
        { url: 'https://example.com/img3.jpg', width: 1000, height: 1000, backgroundScore: 0.85 },
      ],
      attributes: {
        gtin: '4548736134322',
        Marke: 'Sony',
        Modell: 'WH-1000XM5',
        Farbe: 'Schwarz',
        Verbindung: 'Bluetooth',
        requiredAspects: ['Marke', 'Modell', 'Farbe', 'Verbindung'],
      },
    },
  };
  // Shallow-merge sufficient for the test fixtures here.
  return {
    ...base,
    ...overrides,
    identification: { ...base.identification, ...(overrides.identification || {}) },
    details: { ...base.details, ...(overrides.details || {}) },
  };
}

function buildLongDescription(wordCount, keywords = []) {
  // Insert keywords spread across the body. Returns plain HTML.
  const filler =
    'Dieses Produkt bietet hochwertige Verarbeitung und langlebige Materialien für den ' +
    'täglichen Einsatz. Die durchdachte Konstruktion garantiert maximalen Komfort und ' +
    'eine professionelle Performance auf höchstem Niveau für anspruchsvolle Nutzer. ';
  const fillerWords = filler.split(/\s+/).filter(Boolean);
  const result = [];
  while (result.length < wordCount) {
    result.push(fillerWords[result.length % fillerWords.length]);
    if (keywords.length && result.length % 12 === 0) {
      const kw = keywords[(result.length / 12) % keywords.length];
      result.push(kw);
    }
  }
  return `<section><p>${result.slice(0, wordCount).join(' ')}</p></section>`;
}

describe('lib/cassini-scorer', () => {
  describe('scoreProductCassini — overall shape', () => {
    it('returns overall in [0,1] and all sub-scores in [0,1]', () => {
      const { scoreProductCassini } = loadScorer();
      const out = scoreProductCassini(makeProduct({
        details: { description: buildLongDescription(200, ['sony', 'kopfhorer', 'wireless']) },
      }));
      expect(out.overall).toBeGreaterThanOrEqual(0);
      expect(out.overall).toBeLessThanOrEqual(1);
      for (const k of ['title_score', 'description_score', 'image_score', 'specifics_score', 'compliance_score']) {
        expect(out[k]).toBeGreaterThanOrEqual(0);
        expect(out[k]).toBeLessThanOrEqual(1);
      }
      expect(Array.isArray(out.issues)).toBe(true);
      expect(out).toHaveProperty('datasheet_quality_raw');
    });

    it('returns 0 overall for empty product (defensive)', () => {
      const { scoreProductCassini } = loadScorer();
      const out = scoreProductCassini({});
      expect(out.overall).toBeGreaterThanOrEqual(0);
      expect(out.overall).toBeLessThanOrEqual(1);
      expect(out.title_score).toBe(0);
      expect(out.description_score).toBe(0);
      expect(out.image_score).toBe(0);
      expect(out.specifics_score).toBe(0);
    });
  });

  describe('scoreTitle', () => {
    it('penalizes if brand not in first 5 words', () => {
      const { scoreTitle } = loadScorer();
      const product = makeProduct({
        identification: {
          brand: 'Sony',
          name: 'Wireless Bluetooth Noise Cancelling Premium Kopfhörer Sony WH-1000XM5 OVP',
        },
      });
      const out = scoreTitle(product);
      const ruleNames = out.issues.map((i) => i.rule);
      expect(ruleNames).toContain('title_brand_not_first_5');
      expect(out.score).toBeLessThan(0.9);
    });

    it('rewards full 80-char usage (length close to 80)', () => {
      const { scoreTitle } = loadScorer();
      // Construct a title exactly 80 chars with brand at front.
      let t80 = 'Sony WH-1000XM5 Wireless Bluetooth Kopfhörer Noise Cancelling Schwarz Neu';
      while (t80.length < 80) t80 += 'X';
      t80 = t80.slice(0, 80);
      expect(t80.length).toBe(80);
      const product = makeProduct({
        identification: { brand: 'Sony', name: t80 },
      });
      const out = scoreTitle(product);
      expect(out.score).toBeGreaterThanOrEqual(0.9);

      // Compare to a much shorter title — full-length should score higher.
      const tShort = 'Sony WH-1000XM5';
      const outShort = scoreTitle(makeProduct({
        identification: { brand: 'Sony', name: tShort },
      }));
      expect(out.score).toBeGreaterThan(outShort.score);
    });

    it('flags forbidden special chars (& ! _)', () => {
      const { scoreTitle } = loadScorer();
      const product = makeProduct({
        identification: {
          brand: 'Sony',
          name: 'Sony WH-1000XM5 Wireless & Premium! Kopfhörer Noise_Cancelling Schwarz Neu OVP',
        },
      });
      const out = scoreTitle(product);
      const ruleNames = out.issues.map((i) => i.rule);
      expect(ruleNames).toContain('title_special_chars');
    });

    // ------------------------------------------------------------------
    // F.2.0 — 9-Pattern-Title-Enforcement
    // Quelle: Strategischer eBay Leitfaden Sektion 9 (Kategorie-spezifische
    // Title-Patterns). Der Scorer holt Bucket via getCassiniCategoryBucket()
    // aus identification.category bzw. details.categoryId / -Breadcrumb und
    // misst, welcher Anteil der erwarteten Slots im Titel auftaucht.
    // ------------------------------------------------------------------
    it('boosts title score when category-pattern slots are present (Fashion)', () => {
      const { scoreTitle } = loadScorer();
      const product = {
        identification: {
          name: "Levi's 501 Jeans Damen W28 L32 Blau Denim Vintage",
          brand: "Levi's",
          category: 'Kleidung & Accessoires > Damenmode > Damen-Jeans',
        },
        details: {
          categoryId: '11450',
          categoryBreadcrumb: 'Kleidung & Accessoires > Damenmode > Damen-Jeans',
          attributes: {
            Marke: "Levi's",
            Modell: '501',
            Produkttyp: 'Jeans',
            Zielgruppe: 'Damen',
            Größe: 'W28 L32',
            Farbe: 'Blau',
            Material: 'Denim',
          },
        },
      };
      const out = scoreTitle(product);
      expect(out.patternBucket).toBe('fashion');
      expect(out.titlePatternMatch).toBeGreaterThanOrEqual(0.7);
      // Bei sehr hoher Slot-Compliance KEINE pattern_slots_missing-Warnung.
      const ruleNames = out.issues.map((i) => i.rule);
      expect(ruleNames).not.toContain('title_pattern_slots_missing');
    });

    it('penalizes title that omits required pattern slots', () => {
      const { scoreTitle } = loadScorer();
      const product = {
        identification: {
          name: "Levi's Jeans",
          brand: "Levi's",
          category: 'Kleidung & Accessoires > Damenmode > Damen-Jeans',
        },
        details: {
          categoryId: '11450',
          categoryBreadcrumb: 'Kleidung & Accessoires > Damenmode > Damen-Jeans',
          attributes: {
            Marke: "Levi's",
            // Modell, Zielgruppe, Größe, Farbe, Material fehlen.
          },
        },
      };
      const out = scoreTitle(product);
      expect(out.patternBucket).toBe('fashion');
      // Nur Marke + Produkttyp im Titel → höchstens 2 von 7 Slots erfüllt.
      expect(out.titlePatternMatch).toBeLessThan(0.5);
      const ruleNames = out.issues.map((i) => i.rule);
      expect(ruleNames).toContain('title_pattern_slots_missing');
    });

    it('handles unknown bucket with default pattern (no enforcement, no crash)', () => {
      const { scoreTitle } = loadScorer();
      const product = {
        identification: {
          name: 'Unbekanntes Produkt Modell X Premium',
          brand: 'Acme',
          category: 'Sonstige Spezialnische ohne Mapping',
        },
        details: {
          // Keine categoryId, Breadcrumb matcht keine Keywords → bucket='default'.
          categoryId: '',
          categoryBreadcrumb: 'Sonstige Spezialnische ohne Mapping',
          attributes: {
            Marke: 'Acme',
          },
        },
      };
      const out = scoreTitle(product);
      // 'default' bucket darf keinen Pattern-Slot-Penalty werfen.
      expect(out.patternBucket).toBe(null);
      expect(out.titlePatternMatch).toBe(1);
      const ruleNames = out.issues.map((i) => i.rule);
      expect(ruleNames).not.toContain('title_pattern_slots_missing');
    });

    it('returns pattern_match field in scoreTitle output', () => {
      const { scoreTitle } = loadScorer();
      // Baseline product (electronics — Sony WH-1000XM5).
      const out = scoreTitle(makeProduct());
      expect(out).toHaveProperty('titlePatternMatch');
      expect(typeof out.titlePatternMatch).toBe('number');
      expect(out.titlePatternMatch).toBeGreaterThanOrEqual(0);
      expect(out.titlePatternMatch).toBeLessThanOrEqual(1);
      expect(out).toHaveProperty('patternBucket');
    });
  });

  describe('scoreDescription', () => {
    it('rewards target word-count 180-220', () => {
      const { scoreDescription } = loadScorer();
      const product = makeProduct({
        details: { description: buildLongDescription(200, ['sony', 'kopfhorer', 'wireless']) },
      });
      const out = scoreDescription(product);
      expect(out.score).toBeGreaterThanOrEqual(0.5);
      // No "off target" issue should trigger inside 180-220.
      const ruleNames = out.issues.map((i) => i.rule);
      expect(ruleNames).not.toContain('description_word_count_off_target');
    });

    it('zero keyword density triggers description_density_off warning', () => {
      const { scoreDescription } = loadScorer();
      // 200-word description with zero overlap to title keywords.
      const lowDensity = makeProduct({
        identification: {
          brand: 'Sony',
          name: 'Sony Kopfhörer Wireless Bluetooth Noise Cancelling Schwarz Neu OVP',
        },
        details: {
          description: '<p>' + buildLongDescription(200, []).replace(/<[^>]+>/g, ' ') + '</p>',
        },
      });
      const outLow = scoreDescription(lowDensity);
      // Word count is on-target (200) so word_score=1.0, but density=0% must
      // trigger the off-warning.
      expect(outLow.issues.some((i) => i.rule === 'description_density_off')).toBe(true);
    });

    it('density inside 5-7% does not trigger density_off warning', () => {
      const { scoreDescription } = loadScorer();
      // Hand-craft body to hit ~6% density. Title top-3 = sony,kopfhorer,wireless.
      // We want roughly 6 hits per 100 non-stop tokens → 6%.
      // Generate a body of ~100 non-stop tokens with 6 keyword occurrences.
      const fillerWord = 'Material'; // single non-stop token, repeats fine
      const bodyTokens = [];
      for (let i = 0; i < 100; i++) {
        if (i === 10) bodyTokens.push('Sony');
        else if (i === 25) bodyTokens.push('Sony');
        else if (i === 40) bodyTokens.push('Kopfhörer');
        else if (i === 55) bodyTokens.push('Kopfhörer');
        else if (i === 70) bodyTokens.push('Wireless');
        else if (i === 85) bodyTokens.push('Wireless');
        else bodyTokens.push(fillerWord);
      }
      const product = makeProduct({
        identification: {
          brand: 'Sony',
          name: 'Sony Kopfhörer Wireless Bluetooth Noise Cancelling Schwarz Neu OVP',
        },
        details: { description: '<p>' + bodyTokens.join(' ') + '</p>' },
      });
      const out = scoreDescription(product);
      const ruleNames = out.issues.map((i) => i.rule);
      // Density should be ~6% → no "off" warning.
      expect(ruleNames).not.toContain('description_density_off');
    });

    it('flags missing description as error', () => {
      const { scoreDescription } = loadScorer();
      const product = makeProduct({ details: { description: '', short_description: '' } });
      const out = scoreDescription(product);
      expect(out.score).toBe(0);
      expect(out.issues.some((i) => i.rule === 'description_missing')).toBe(true);
    });
  });

  describe('scoreImage', () => {
    it('returns 0 score and error if no images', () => {
      const { scoreImage } = loadScorer();
      const product = makeProduct({ details: { images: [] } });
      const out = scoreImage(product);
      expect(out.score).toBe(0);
      expect(out.issues.some((i) => i.rule === 'image_missing' && i.severity === 'error')).toBe(true);
    });

    it('rewards high-resolution + white background + 3+ images', () => {
      const { scoreImage } = loadScorer();
      const out = scoreImage(makeProduct());
      expect(out.score).toBeGreaterThanOrEqual(0.9);
    });

    it('penalizes low resolution main image', () => {
      const { scoreImage } = loadScorer();
      const product = makeProduct({
        details: {
          images: [
            { url: 'a', width: 300, height: 300, backgroundScore: 0.95 },
            { url: 'b', width: 1000, height: 1000, backgroundScore: 0.95 },
            { url: 'c', width: 1000, height: 1000, backgroundScore: 0.95 },
          ],
        },
      });
      const out = scoreImage(product);
      const ruleNames = out.issues.map((i) => i.rule);
      expect(ruleNames.some((r) => r.startsWith('image_'))).toBe(true);
      expect(out.score).toBeLessThan(0.9);
    });
  });

  describe('scoreSpecifics', () => {
    it('returns 0 if no GTIN/EAN/UPC/MPN', () => {
      const { scoreSpecifics } = loadScorer();
      const product = makeProduct({
        identification: { name: 'Whatever', brand: 'Sony', gtin: '' },
        details: {
          attributes: {
            Marke: 'Sony',
            Modell: 'X',
            requiredAspects: ['Marke', 'Modell'],
          },
        },
      });
      const out = scoreSpecifics(product);
      expect(out.score).toBe(0);
      expect(out.issues.some((i) => i.rule === 'specifics_no_identifier')).toBe(true);
    });

    it('rewards full required-aspect fill rate', () => {
      const { scoreSpecifics } = loadScorer();
      const out = scoreSpecifics(makeProduct());
      expect(out.score).toBeGreaterThanOrEqual(0.9);
    });

    it('penalizes underfilled required aspects', () => {
      const { scoreSpecifics } = loadScorer();
      const product = makeProduct({
        details: {
          attributes: {
            gtin: '4548736134322',
            requiredAspects: ['Marke', 'Modell', 'Farbe', 'Verbindung'],
          },
        },
      });
      const out = scoreSpecifics(product);
      const ruleNames = out.issues.map((i) => i.rule);
      expect(ruleNames).toContain('specifics_required_aspects_underfilled');
    });

    // ----------------------------------------------------------------
    // Defensive GTIN lookup across all real write-paths.
    // Regression-Guard: V3/V4 assembleProduct writes to
    // `details.identifiers.*` and `identification.barcodes[]` —
    // NOT to `identification.gtin`. The scorer must find them anyway.
    // ----------------------------------------------------------------
    describe('lookupIdentifier — defensive multi-path GTIN read', () => {
      it('finds GTIN via details.identifiers.gtin (V3/V4 authoritative path)', () => {
        const { scoreSpecifics } = loadScorer();
        // Strip the baseline's attributes.gtin and identification.gtin —
        // ensure ONLY the identifiers map is the source.
        const product = makeProduct({
          identification: { gtin: '' },
          details: {
            identifiers: { gtin: '4548736134322' },
            attributes: {
              Marke: 'Sony',
              Modell: 'WH-1000XM5',
              Farbe: 'Schwarz',
              Verbindung: 'Bluetooth',
              requiredAspects: ['Marke', 'Modell', 'Farbe', 'Verbindung'],
            },
          },
        });
        const out = scoreSpecifics(product);
        expect(out.score).toBeGreaterThan(0);
        expect(out.issues.some((i) => i.rule === 'specifics_no_identifier')).toBe(false);
      });

      it('finds GTIN via identification.barcodes[] (V3/V4 mixed-array path)', () => {
        const { scoreSpecifics } = loadScorer();
        const product = makeProduct({
          identification: { gtin: '', barcodes: ['4548736134322'] },
          details: {
            attributes: {
              Marke: 'Sony',
              Modell: 'WH-1000XM5',
              Farbe: 'Schwarz',
              Verbindung: 'Bluetooth',
              requiredAspects: ['Marke', 'Modell', 'Farbe', 'Verbindung'],
            },
          },
        });
        const out = scoreSpecifics(product);
        expect(out.score).toBeGreaterThan(0);
        expect(out.issues.some((i) => i.rule === 'specifics_no_identifier')).toBe(false);
      });

      it('finds GTIN via details.attributes.gtin (V4 aspect-map path)', () => {
        const { scoreSpecifics } = loadScorer();
        const product = makeProduct({
          identification: { gtin: '' },
          details: {
            attributes: {
              gtin: '4548736134322',
              Marke: 'Sony',
              Modell: 'WH-1000XM5',
              Farbe: 'Schwarz',
              Verbindung: 'Bluetooth',
              requiredAspects: ['Marke', 'Modell', 'Farbe', 'Verbindung'],
            },
          },
        });
        const out = scoreSpecifics(product);
        expect(out.score).toBeGreaterThan(0);
        expect(out.issues.some((i) => i.rule === 'specifics_no_identifier')).toBe(false);
      });

      it('finds GTIN via identification.gtin (legacy/manual path)', () => {
        const { scoreSpecifics } = loadScorer();
        const product = makeProduct({
          identification: { gtin: '4548736134322' },
          details: {
            attributes: {
              Marke: 'Sony',
              Modell: 'WH-1000XM5',
              Farbe: 'Schwarz',
              Verbindung: 'Bluetooth',
              requiredAspects: ['Marke', 'Modell', 'Farbe', 'Verbindung'],
            },
          },
        });
        const out = scoreSpecifics(product);
        expect(out.score).toBeGreaterThan(0);
        expect(out.issues.some((i) => i.rule === 'specifics_no_identifier')).toBe(false);
      });

      it('returns 0 only when ALL four paths are empty', () => {
        const { scoreSpecifics } = loadScorer();
        const product = makeProduct({
          identification: { gtin: '', barcodes: [] },
          details: {
            identifiers: {},
            attributes: {
              Marke: 'Sony',
              Modell: 'WH-1000XM5',
              requiredAspects: ['Marke', 'Modell'],
            },
          },
        });
        const out = scoreSpecifics(product);
        expect(out.score).toBe(0);
        expect(out.issues.some((i) => i.rule === 'specifics_no_identifier')).toBe(true);
      });

      it('lookupIdentifier helper exposes correct EAN-13 detection from barcodes[]', () => {
        const { _internal } = loadScorer();
        const product = {
          identification: { barcodes: ['4548736134322', '12345', 'SOMEMPN'] },
        };
        expect(_internal.lookupIdentifier(product, 'gtin')).toBe('4548736134322');
        expect(_internal.lookupIdentifier(product, 'ean')).toBe('4548736134322');
        expect(_internal.lookupIdentifier(product, 'upc')).toBe('');
      });
    });
  });

  describe('scoreCompliance', () => {
    it('detects active content (<script>, <iframe>, <object>, <embed>)', () => {
      const { scoreCompliance } = loadScorer();
      for (const tag of ['<script>alert(1)</script>', '<iframe src="x"></iframe>', '<object data="x"></object>', '<embed src="x">']) {
        const product = makeProduct({
          details: { description: `<p>Hi</p>${tag}` },
        });
        const out = scoreCompliance(product);
        expect(out.score).toBeLessThan(0.5);
        expect(out.issues.some((i) => i.rule === 'compliance_active_content' && i.severity === 'error')).toBe(true);
      }
    });

    it('flags keyword spamming when a token repeats >2× in title', () => {
      const { scoreCompliance } = loadScorer();
      const product = makeProduct({
        identification: { name: 'Sony Sony Sony Sony Kopfhörer Wireless' },
      });
      const out = scoreCompliance(product);
      expect(out.issues.some((i) => i.rule === 'compliance_keyword_spam')).toBe(true);
    });

    it('clean product receives full compliance score', () => {
      const { scoreCompliance } = loadScorer();
      const out = scoreCompliance(makeProduct());
      expect(out.score).toBeGreaterThanOrEqual(0.9);
    });
  });

  describe('defensive wrapping of evaluateEbayReady', () => {
    it('returns fallback datasheet_quality_raw on throw without crashing', () => {
      const { scoreProductCassini } = loadScorer();
      // Patch evaluateEbayReady to throw.
      const cached = require.cache[datasheetQualityPath];
      cached.exports.evaluateEbayReady = () => {
        throw new Error('boom — datasheet-quality is broken');
      };

      const out = scoreProductCassini(makeProduct({
        details: { description: buildLongDescription(200, ['sony']) },
      }));

      expect(out).toHaveProperty('datasheet_quality_raw');
      expect(out.datasheet_quality_raw.ok).toBe(false);
      expect(out.datasheet_quality_raw.error.message).toMatch(/boom/i);
      // Sub-scores still computed independently:
      expect(out.title_score).toBeGreaterThan(0);
    });

    it('passes through real datasheet_quality_raw on success', () => {
      const { scoreProductCassini } = loadScorer();
      const out = scoreProductCassini(makeProduct({
        details: { description: buildLongDescription(200, ['sony']) },
      }));
      expect(out.datasheet_quality_raw).toBeTruthy();
      expect(out.datasheet_quality_raw).toHaveProperty('snapshot');
    });
  });
});
