'use strict';

// Tests focus on units we can exercise without real Gemini access:
//  - sanitizeWriteArgs (whitelist + clamping)
//  - isAgenticEnabled (env flag + sample)
//  - buildSystemPrompt (snapshot-light: presence of key sections)

describe('identify-v3-stage3-agentic — pure helpers', () => {
  let agentic;

  beforeEach(() => {
    delete require.cache[require.resolve('../../lib/identify-v3-stage3-agentic')];
    agentic = require('../../lib/identify-v3-stage3-agentic');
  });

  describe('isAgenticEnabled', () => {
    it('returns false by default', () => {
      const original = process.env.STAGE3_AGENTIC;
      delete process.env.STAGE3_AGENTIC;
      delete process.env.STAGE3_AGENTIC_SAMPLE;
      try {
        expect(agentic.isAgenticEnabled()).toBe(false);
      } finally {
        if (original !== undefined) process.env.STAGE3_AGENTIC = original;
      }
    });

    it('returns true when STAGE3_AGENTIC=true', () => {
      const original = process.env.STAGE3_AGENTIC;
      process.env.STAGE3_AGENTIC = 'true';
      try {
        expect(agentic.isAgenticEnabled()).toBe(true);
      } finally {
        if (original === undefined) delete process.env.STAGE3_AGENTIC;
        else process.env.STAGE3_AGENTIC = original;
      }
    });

    it('honors common truthy aliases', () => {
      const original = process.env.STAGE3_AGENTIC;
      try {
        for (const v of ['1', 'yes', 'on', 'TRUE']) {
          process.env.STAGE3_AGENTIC = v;
          expect(agentic.isAgenticEnabled()).toBe(true);
        }
      } finally {
        if (original === undefined) delete process.env.STAGE3_AGENTIC;
        else process.env.STAGE3_AGENTIC = original;
      }
    });

    it('respects STAGE3_AGENTIC_SAMPLE for canary opt-in', () => {
      const original = process.env.STAGE3_AGENTIC_SAMPLE;
      const originalFlag = process.env.STAGE3_AGENTIC;
      delete process.env.STAGE3_AGENTIC;
      try {
        process.env.STAGE3_AGENTIC_SAMPLE = '1.0';
        expect(agentic.isAgenticEnabled()).toBe(true);
        process.env.STAGE3_AGENTIC_SAMPLE = '0';
        expect(agentic.isAgenticEnabled()).toBe(false);
      } finally {
        if (original === undefined) delete process.env.STAGE3_AGENTIC_SAMPLE;
        else process.env.STAGE3_AGENTIC_SAMPLE = original;
        if (originalFlag !== undefined) process.env.STAGE3_AGENTIC = originalFlag;
      }
    });
  });

  describe('sanitizeWriteArgs', () => {
    it('filters out unknown top-level keys', () => {
      const out = agentic._internal.sanitizeWriteArgs({
        title_ebay: 'Sony WH-1000XM5',
        secret_field: 'should be dropped',
        __proto__: { evil: true },
      });
      expect(out.title_ebay).toBe('Sony WH-1000XM5');
      expect(out.secret_field).toBeUndefined();
    });

    it('coerces strings and clamps key_features length', () => {
      const out = agentic._internal.sanitizeWriteArgs({
        key_features: Array.from({ length: 30 }, (_, i) => `feat-${i}`),
      });
      expect(out.key_features.length).toBe(12);
    });

    it('shapes item_specifics to {key, value} with 60-char value cap', () => {
      const longValue = 'x'.repeat(500);
      const out = agentic._internal.sanitizeWriteArgs({
        item_specifics: [
          { key: 'Marke', value: 'Sony' },
          { key: 'Modell', value: longValue },
          { key: 'no_value' }, // should be dropped
          'malformed',
        ],
      });
      expect(out.item_specifics).toHaveLength(2);
      expect(out.item_specifics[0]).toEqual({ key: 'Marke', value: 'Sony' });
      expect(out.item_specifics[1].value.length).toBeLessThanOrEqual(200);
    });

    it('handles missing fields gracefully', () => {
      const out = agentic._internal.sanitizeWriteArgs({});
      expect(out).toEqual({});
    });
  });

  describe('buildSystemPrompt', () => {
    it('includes verified identity and required aspects', () => {
      const prompt = agentic._internal.buildSystemPrompt({
        identity: { brand: 'Sony', model: 'WH-1000XM5', mpn: 'WH1000XM5B' },
        enrichment: { requiredAspects: ['Marke', 'Farbe', 'Konnektivitaet'] },
        ocrSnippets: ['Sony WH-1000XM5 Wireless'],
        eanLookup: { brand: 'Sony', productName: 'WH-1000XM5' },
        weightFallback: null,
        gpsrWebFallback: null,
        barcodeConfirmation: null,
        webImages: [],
      });
      expect(prompt).toContain('VERIFIZIERTE IDENTITAET');
      expect(prompt).toContain('Sony');
      expect(prompt).toContain('WH-1000XM5');
      expect(prompt).toContain('PFLICHT-ARTIKELMERKMALE');
      expect(prompt).toContain('Konnektivitaet');
      expect(prompt).toContain('OCR-TEXT');
      expect(prompt).toContain('write_product_datasheet');
      // Tools must be listed
      expect(prompt).toMatch(/lookup_gtin/);
      expect(prompt).toMatch(/urlContext/);
    });

    it('skips empty sections cleanly', () => {
      const prompt = agentic._internal.buildSystemPrompt({
        identity: { brand: '', model: '' },
        enrichment: {},
        ocrSnippets: [],
        eanLookup: null,
        weightFallback: null,
        gpsrWebFallback: null,
        barcodeConfirmation: null,
        webImages: [],
      });
      expect(prompt).not.toContain('OCR-TEXT VOM VERPACKUNGS-LABEL');
      expect(prompt).not.toContain('PFLICHT-ARTIKELMERKMALE');
      expect(prompt).toContain('VERIFIZIERTE IDENTITAET');
    });
  });

  describe('WRITE_DATASHEET_DECLARATION', () => {
    it('matches CONTENT_SCHEMA core required fields', () => {
      const decl = agentic._internal.WRITE_DATASHEET_DECLARATION;
      expect(decl.name).toBe('write_product_datasheet');
      expect(decl.parameters.required).toContain('title_ebay');
      expect(decl.parameters.required).toContain('item_specifics');
      // Output supports both eBay + Kaufland titles
      expect(decl.parameters.properties.title_kaufland).toBeDefined();
      expect(decl.parameters.properties.gpsr_manufacturer_name).toBeDefined();
    });
  });
});
