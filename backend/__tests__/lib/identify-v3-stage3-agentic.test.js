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
    // Modellpolitik seit 2026-08-26: das Modell-Gate liest resolveModel(null,
    // 'IDENTIFY_MODEL', DEFAULT_MODEL) (derselbe ENV-Key wie die Ausführung —
    // vorher las das Gate GEMINI_IDENTIFY_MODEL und konnte abweichen) und
    // prüft supportsToolContextCirculation. Unter der Default-Politik löst
    // alles auf gemini-3.7-flash auf → Gate OFFEN (Default ON). Unter der
    // Notbremse MODEL_POLICY='gemini25' → Gate ZU, gewinnt auch über
    // explizites STAGE3_AGENTIC=true.
    const ENV_KEYS = [
      'STAGE3_AGENTIC',
      'STAGE3_AGENTIC_SAMPLE',
      'MODEL_POLICY',
      'IDENTIFY_MODEL',
      'GEMINI_IDENTIFY_MODEL',
    ];
    let saved;
    beforeEach(() => {
      saved = {};
      for (const key of ENV_KEYS) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    });
    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });

    it('is ON by default under the default policy (gemini-3.7-flash supports circulation)', () => {
      expect(agentic.isAgenticEnabled()).toBe(true);
    });

    it('truthy aliases stay ON under the default policy', () => {
      for (const v of ['true', '1', 'yes', 'on', 'TRUE']) {
        process.env.STAGE3_AGENTIC = v;
        expect(agentic.isAgenticEnabled()).toBe(true);
      }
    });

    it('returns false on explicit opt-out values (flag wins over capable model)', () => {
      for (const v of ['false', '0', 'no', 'off']) {
        process.env.STAGE3_AGENTIC = v;
        expect(agentic.isAgenticEnabled()).toBe(false);
      }
    });

    it('STAGE3_AGENTIC_SAMPLE is a partial-disable knob when STAGE3_AGENTIC is unset', () => {
      process.env.STAGE3_AGENTIC_SAMPLE = '0';
      expect(agentic.isAgenticEnabled()).toBe(false);
      process.env.STAGE3_AGENTIC_SAMPLE = '1';
      expect(agentic.isAgenticEnabled()).toBe(true);
    });

    it('STAGE3_AGENTIC_SAMPLE is NOT consulted when STAGE3_AGENTIC is set explicitly', () => {
      process.env.STAGE3_AGENTIC = 'true';
      process.env.STAGE3_AGENTIC_SAMPLE = '0';
      expect(agentic.isAgenticEnabled()).toBe(true);
    });

    it('is OFF under the MODEL_POLICY=gemini25 emergency brake', () => {
      process.env.MODEL_POLICY = 'gemini25';
      expect(agentic.isAgenticEnabled()).toBe(false);
    });

    it('stays OFF under the emergency brake even with STAGE3_AGENTIC=true (model gate wins)', () => {
      process.env.MODEL_POLICY = 'gemini25';
      for (const v of ['true', '1', 'yes', 'on', 'TRUE']) {
        process.env.STAGE3_AGENTIC = v;
        expect(agentic.isAgenticEnabled()).toBe(false);
      }
    });

    it('STAGE3_AGENTIC_SAMPLE cannot bypass the emergency-brake model gate', () => {
      process.env.MODEL_POLICY = 'gemini25';
      process.env.STAGE3_AGENTIC_SAMPLE = '1.0';
      expect(agentic.isAgenticEnabled()).toBe(false);
      process.env.STAGE3_AGENTIC_SAMPLE = '0';
      expect(agentic.isAgenticEnabled()).toBe(false);
    });

    it('legacy GEMINI_IDENTIFY_MODEL=gemini-2.5-flash alone changes NOTHING (gate reads IDENTIFY_MODEL, policy normalizes)', () => {
      process.env.GEMINI_IDENTIFY_MODEL = 'gemini-2.5-flash';
      expect(agentic.isAgenticEnabled()).toBe(true);
    });

    it('IDENTIFY_MODEL=gemini-2.5-flash under the default policy still resolves to a circulation-capable model', () => {
      process.env.IDENTIFY_MODEL = 'gemini-2.5-flash';
      expect(agentic.isAgenticEnabled()).toBe(true);
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
