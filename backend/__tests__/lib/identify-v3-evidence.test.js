'use strict';

const {
  buildEvidenceRows,
  buildDraft,
  runStage4CrossReference,
} = require('../../lib/identify-v3-evidence');

const baseStage1 = () => ({
  identity: {
    brand: 'Sony',
    model: 'WH-1000XM5',
    mpn: 'WH1000XM5B',
    variant: 'Schwarz',
    color: 'Schwarz',
    weight_grams: 250,
    internalCategory: 'Elektronik > Kopfhoerer',
  },
  barcodes: { ean: '4548736132610', gtin: '', upc: '' },
  ocrPayload: { textSnippets: ['Sony WH-1000XM5'] },
  eanLookup: { found: true, brand: 'Sony', productName: 'WH-1000XM5', category: 'Audio' },
  v2FallbackRecord: null,
});

const baseStage2 = () => ({
  category: {
    ebayId: '112529',
    ebayBreadcrumb: 'TV, Video & Audio > Kopfhoerer',
    resolver: { source: 'v2:catalog', confidence: 0.92 },
  },
  pricing: {
    amount: 289,
    currency: 'EUR',
    sources: [{ url: 'https://amazon.de/dp/B09', name: 'Amazon' }],
    confidence: 0.85,
  },
  gpsr: { found: true, data: { manufacturer_name: 'Sony Europe B.V.' } },
  gpsrWebFallback: null,
  weightFallback: null,
  barcodeConfirmation: { confirmed: true, evidence: [{ url: 'https://sony.de', title: 'Sony XM5' }] },
  webImages: [{ url: 'https://sony.de/xm5.jpg', title: 'Sony XM5 Hero' }],
  requiredAspects: ['Marke', 'Modell', 'Farbe'],
});

const baseStage3 = () => ({
  title_ebay: 'Sony WH-1000XM5 Bluetooth Over-Ear Kopfhoerer Schwarz',
  description_ebay: '<p>Premium Kopfhoerer von Sony.</p>',
  item_specifics: [
    { key: 'Marke', value: 'Sony' },
    { key: 'Modell', value: 'WH-1000XM5' },
    { key: 'Farbe', value: 'Schwarz' },
  ],
  gpsr_manufacturer_name: 'Sony Europe B.V.',
});

describe('buildEvidenceRows', () => {
  it('emits brand from identity (gemini_inference) and ean_db when EAN-DB hit', () => {
    const rows = buildEvidenceRows(baseStage1(), baseStage2(), baseStage3());
    const brandRows = rows.filter((r) => r.field === 'brand');
    expect(brandRows.find((r) => r.source === 'gemini_inference')).toBeTruthy();
    expect(brandRows.find((r) => r.source === 'ean_db')).toBeTruthy();
  });

  it('rejects placeholder brand values', () => {
    const stage1 = baseStage1();
    stage1.identity.brand = 'Unbekannt';
    const stage3 = { ...baseStage3(), item_specifics: [{ key: 'Marke', value: 'Generic' }] };
    const rows = buildEvidenceRows(stage1, baseStage2(), stage3);
    expect(rows.filter((r) => r.field === 'brand').length).toBe(1); // only ean_db survives
  });

  it('flags GTIN as gs1_verified when barcode is web-confirmed', () => {
    const rows = buildEvidenceRows(baseStage1(), baseStage2(), baseStage3());
    const gtinRow = rows.find((r) => r.field === 'gtin');
    expect(gtinRow?.source).toBe('gs1_verified');
  });

  it('flags GTIN as ocr when no web confirmation', () => {
    const stage2 = { ...baseStage2(), barcodeConfirmation: { confirmed: false } };
    const rows = buildEvidenceRows(baseStage1(), stage2, baseStage3());
    const gtinRow = rows.find((r) => r.field === 'gtin');
    expect(gtinRow?.source).toBe('ocr');
  });

  it('maps category resolver source v2:catalog → ebay_catalog', () => {
    const rows = buildEvidenceRows(baseStage1(), baseStage2(), baseStage3());
    const catIdRow = rows.find((r) => r.field === 'categoryId');
    expect(catIdRow?.source).toBe('ebay_catalog');
  });

  it('maps local category source → gemini_inference (Stage-1 Gemini origin)', () => {
    const stage2 = {
      ...baseStage2(),
      category: { ...baseStage2().category, resolver: { source: 'local', confidence: 0.9 } },
    };
    const rows = buildEvidenceRows(baseStage1(), stage2, baseStage3());
    const catIdRow = rows.find((r) => r.field === 'categoryId');
    expect(catIdRow?.source).toBe('gemini_inference');
  });

  it('emits manufacturer_website for Registry GPSR and gpsrWebFallback', () => {
    const stage2 = baseStage2();
    stage2.gpsrWebFallback = { manufacturer_name: 'Sony Europe B.V.' };
    const rows = buildEvidenceRows(baseStage1(), stage2, baseStage3());
    const gpsrRows = rows.filter((r) => r.field === 'gpsr' && r.source === 'manufacturer_website');
    expect(gpsrRows.length).toBeGreaterThanOrEqual(2);
  });

  it('emits weight from both web fallback and identity', () => {
    const stage2 = { ...baseStage2(), weightFallback: { weight_grams: 250, sources: [] } };
    const rows = buildEvidenceRows(baseStage1(), stage2, baseStage3());
    const weightRows = rows.filter((r) => r.field === 'weight');
    expect(weightRows.find((r) => r.source === 'web_search_broad')).toBeTruthy();
    expect(weightRows.find((r) => r.source === 'gemini_inference')).toBeTruthy();
  });

  it('emits price evidence per source-host', () => {
    const rows = buildEvidenceRows(baseStage1(), baseStage2(), baseStage3());
    const priceRows = rows.filter((r) => r.field === 'price');
    expect(priceRows.length).toBeGreaterThanOrEqual(1);
    expect(priceRows[0].source).toBe('amazon_product');
  });

  it('handles missing optional fields without crashing', () => {
    const rows = buildEvidenceRows({}, {}, {});
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBe(0);
  });
});

describe('buildDraft', () => {
  it('builds draft from stage outputs', () => {
    const draft = buildDraft(baseStage1(), baseStage2(), baseStage3());
    expect(draft.brand).toBe('Sony');
    expect(draft.gtin).toBe('4548736132610');
    expect(draft.categoryId).toBe('112529');
    expect(draft.title).toContain('Sony');
    expect(draft.price).toBe(289);
  });

  it('omits price when amount is 0', () => {
    const stage2 = { ...baseStage2(), pricing: { amount: 0, sources: [] } };
    const draft = buildDraft(baseStage1(), stage2, baseStage3());
    expect(draft.price).toBeUndefined();
  });
});

describe('runStage4CrossReference', () => {
  it('produces a confidence map + aggregate', () => {
    const xref = runStage4CrossReference(baseStage1(), baseStage2(), baseStage3());
    expect(typeof xref.evidenceCount).toBe('number');
    expect(xref.evidenceCount).toBeGreaterThan(0);
    expect(xref.confidence).toBeDefined();
    expect(xref.aggregate).toBeDefined();
    expect(typeof xref.aggregate.score).toBe('number');
  });

  it('marks brand as passing when GTIN-DB + Stage-1 + Stage-3 agree', () => {
    const xref = runStage4CrossReference(baseStage1(), baseStage2(), baseStage3());
    const brandConf = xref.confidence.brand;
    expect(brandConf).toBeDefined();
    expect(brandConf.passes).toBe(true);
  });

  it('detects conflict when Stage-1 brand and EAN-DB brand disagree', () => {
    const stage1 = baseStage1();
    stage1.identity.brand = 'Bose'; // conflicts with eanLookup.brand=Sony
    const xref = runStage4CrossReference(stage1, baseStage2(), {
      ...baseStage3(),
      item_specifics: [],
    });
    // Either conflict is detected OR brand confidence is degraded by disagreement.
    // The cross-referencer uses CONFLICT_SUPPORT_RATIO=0.7 and effective-support
    // weighting, which doesn't always trip a hard conflict on a 1-vs-1 split,
    // so we accept either signal.
    const conflictDetected = xref.conflicts.some((c) => c.field === 'brand');
    const brandPasses = xref.confidence.brand?.passes;
    expect(conflictDetected || brandPasses === false).toBe(true);
  });

  it('aggregates a non-zero score for a typical product', () => {
    const xref = runStage4CrossReference(baseStage1(), baseStage2(), baseStage3());
    expect(xref.aggregate.score).toBeGreaterThan(0.5);
  });

  it('returns empty results gracefully for empty stages', () => {
    const xref = runStage4CrossReference({}, {}, {});
    expect(xref.evidenceCount).toBe(0);
    expect(xref.aggregate.score).toBe(0);
  });
});
