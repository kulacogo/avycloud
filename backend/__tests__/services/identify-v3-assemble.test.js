'use strict';

// Regression tests for the V3 assembleProduct() data-flow fixes shipped on
// 2026-05-07. Each `it()` corresponds to one previously-leaking bug:
//   - weight web fallback discarded (was: weight_grams = stage1 only)
//   - GPSR strict precedence (was: first-source-wins, partial sources lost)
//   - item_specifics_confidence dropped (was: assembleProduct ignored map)
//   - GPSR web fallback `manufacturer_email` read as `email` (typo bug)
//
// The stage outputs below are minimal — only fields exercised by assembleProduct
// are populated. Real pipeline output is much richer.

const { _assembleProduct } = require('../../services/identify-v3');

const baseStage1 = () => ({
  identity: {
    brand: 'Gr4tec',
    model: 'YD25L-AW005',
    mpn: 'YD25L-AW005-65AW',
    color: 'Weiß',
    internalCategory: 'Beleuchtung > Einbaustrahler',
    weight_grams: 0,
  },
  barcodes: { ranked: [], ean: null, gtin: null, upc: null },
  uploadedImages: [],
  webImageUrls: [],
});

const baseStage2 = () => ({
  category: { ebayId: '20706', ebayBreadcrumb: 'Beleuchtung > Einbaustrahler', resolver: { source: 'local' } },
  pricing: null,
  gpsr: { found: false, data: null },
  gpsrWebFallback: null,
  webImages: [],
  weightFallback: null,
});

const baseStage3 = () => ({
  title_ebay: 'Gr4tec YD25L-AW005 Einbaustrahler',
  description_ebay: '<p>Gr4tec YD25L-AW005</p>',
  description_kaufland: '<p>Gr4tec YD25L-AW005</p>',
  key_features: ['Gr4tec', 'YD25L-AW005'],
  item_specifics: [
    { key: 'Marke', value: 'Gr4tec' },
    { key: 'Modell', value: 'YD25L-AW005' },
    { key: 'Lichtfarbe', value: 'Kaltweiß' },
    { key: 'Wattage', value: 'Unbekannt' },
  ],
  item_specifics_confidence: {
    Marke: 1,
    Modell: 1,
    Lichtfarbe: 0.7,
    Wattage: 0,
  },
});

const opts = { locale: 'de-DE', lotCode: 'L-072604', inventoryId: null };

describe('V3 assembleProduct — weight web fallback', () => {
  it('uses Stage 1 weight when present (most authoritative)', () => {
    const stage1 = baseStage1();
    stage1.identity.weight_grams = 350;
    const stage2 = baseStage2();
    stage2.weightFallback = { weight_grams: 999, confidence: 0.4 };
    const product = _assembleProduct('id', stage1, stage2, baseStage3(), opts);
    expect(product.ops.weight_grams).toBe(350);
  });

  it('falls back to Stage 2 weight web lookup when Stage 1 has none', () => {
    const stage1 = baseStage1();
    stage1.identity.weight_grams = 0;
    const stage2 = baseStage2();
    stage2.weightFallback = { weight_grams: 220, confidence: 0.65, sources: ['https://x.com'] };
    const product = _assembleProduct('id', stage1, stage2, baseStage3(), opts);
    expect(product.ops.weight_grams).toBe(220);
  });

  it('returns null when neither Stage 1 nor Stage 2 has weight', () => {
    const product = _assembleProduct('id', baseStage1(), baseStage2(), baseStage3(), opts);
    expect(product.ops.weight_grams).toBe(null);
  });

  it('ignores invalid weightFallback weight_grams', () => {
    const stage1 = baseStage1();
    stage1.identity.weight_grams = 0;
    const stage2 = baseStage2();
    stage2.weightFallback = { weight_grams: 'NaN-string' };
    const product = _assembleProduct('id', stage1, stage2, baseStage3(), opts);
    expect(product.ops.weight_grams).toBe(null);
  });
});

describe('V3 assembleProduct — GPSR field-by-field merge', () => {
  it('uses registry data verbatim when registry is complete', () => {
    const stage2 = baseStage2();
    stage2.gpsr = {
      found: true,
      data: {
        manufacturer_name: 'Sony Europe B.V.',
        manufacturer_address: 'Da Vincilaan 7-D1, Zaventem',
        email: 'info@sony.eu',
        manufacturer_phone: '+32 2 717 5000',
        entity_country: 'BE',
      },
    };
    const product = _assembleProduct('id', baseStage1(), stage2, baseStage3(), opts);
    expect(product.details.gpsr.manufacturer_name).toBe('Sony Europe B.V.');
    expect(product.details.gpsr.email).toBe('info@sony.eu');
    expect(product.details.gpsr.entity_country).toBe('BE');
  });

  it('merges registry name with web-fallback address when registry is partial', () => {
    const stage2 = baseStage2();
    stage2.gpsr = { found: true, data: { manufacturer_name: 'Gr4tec', manufacturer_address: '', email: '' } };
    stage2.gpsrWebFallback = {
      manufacturer_name: 'Shenzhen Gr4tec Co Ltd',
      manufacturer_address: '5F, Building A, Tech Park, Shenzhen 518000, China',
      manufacturer_email: 'support@gr4tec.com',
    };
    const product = _assembleProduct('id', baseStage1(), stage2, baseStage3(), opts);
    // Highest-priority source wins for name (registry).
    expect(product.details.gpsr.manufacturer_name).toBe('Gr4tec');
    // Web fallback fills in address + email that registry lacked.
    expect(product.details.gpsr.manufacturer_address).toContain('Shenzhen');
    expect(product.details.gpsr.email).toBe('support@gr4tec.com');
  });

  it('reads manufacturer_email from web fallback (not the previous broken `email` key)', () => {
    const stage2 = baseStage2();
    stage2.gpsrWebFallback = {
      manufacturer_name: 'Gr4tec',
      manufacturer_email: 'support@gr4tec.com',
    };
    const product = _assembleProduct('id', baseStage1(), stage2, baseStage3(), opts);
    expect(product.details.gpsr.email).toBe('support@gr4tec.com');
  });

  it('returns undefined GPSR when no source has any data', () => {
    const product = _assembleProduct('id', baseStage1(), baseStage2(), baseStage3(), opts);
    expect(product.details.gpsr).toBeUndefined();
  });

  it('uses Stage-3 LLM data when registry is absent', () => {
    const stage3 = baseStage3();
    stage3.gpsr_manufacturer_name = 'Tetra GmbH';
    stage3.gpsr_manufacturer_address = 'Herrieder Str. 7, 91522 Ansbach';
    stage3.gpsr_manufacturer_email = 'service@tetra.de';
    const product = _assembleProduct('id', baseStage1(), baseStage2(), stage3, opts);
    expect(product.details.gpsr.manufacturer_name).toBe('Tetra GmbH');
    expect(product.details.gpsr.email).toBe('service@tetra.de');
  });
});

describe('V3 assembleProduct — attribute_confidence propagation', () => {
  it('copies item_specifics_confidence map to details.attribute_confidence', () => {
    const product = _assembleProduct('id', baseStage1(), baseStage2(), baseStage3(), opts);
    expect(product.details.attribute_confidence).toBeDefined();
    expect(product.details.attribute_confidence.Marke).toBe(1);
    expect(product.details.attribute_confidence.Wattage).toBe(0);
    expect(product.details.attribute_confidence.Lichtfarbe).toBeCloseTo(0.7);
  });

  it('returns undefined when stage3 produced no confidence map', () => {
    const stage3 = baseStage3();
    delete stage3.item_specifics_confidence;
    const product = _assembleProduct('id', baseStage1(), baseStage2(), stage3, opts);
    expect(product.details.attribute_confidence).toBeUndefined();
  });

  it('snapshots the confidence map (no aliasing back to stage3)', () => {
    const stage3 = baseStage3();
    const product = _assembleProduct('id', baseStage1(), baseStage2(), stage3, opts);
    stage3.item_specifics_confidence.Marke = 0.1;
    // Mutating the original stage3 map must not bleed into the product.
    expect(product.details.attribute_confidence.Marke).toBe(1);
  });
});
