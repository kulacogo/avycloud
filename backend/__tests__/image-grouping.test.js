/**
 * Tests for image-grouping service — parseGroupingResponse & buildGroupingPrompt.
 */
const {
  buildGroupingPrompt,
  parseGroupingResponse,
  buildMultiProductPrompt,
  parseDetectionResponse,
  GROUPING_SCHEMA,
  VISION_DETECTION_CONFIG,
} = require('../services/image-grouping');

describe('buildGroupingPrompt', () => {
  it('includes image count in prompt', () => {
    const prompt = buildGroupingPrompt(5);
    expect(prompt).toContain('5 Bilder');
  });

  it('includes anti-hallucination rules', () => {
    const prompt = buildGroupingPrompt(3);
    expect(prompt).toContain('Erfinde KEINE');
  });

  it('prefers separate groups over merging (BUG-090)', () => {
    const prompt = buildGroupingPrompt(10);
    expect(prompt).toContain('lieber eine Gruppe zu VIEL');
    expect(prompt).not.toContain('alles in EINE Gruppe');
  });

  it('indicates images likely show different products', () => {
    const prompt = buildGroupingPrompt(15);
    expect(prompt).toContain('WAHRSCHEINLICH verschiedene Produkte');
  });
});

describe('parseGroupingResponse', () => {
  it('parses valid JSON with groups', () => {
    const response = JSON.stringify({
      product_count: 2,
      groups: [
        { label: 'Nike Schuh', image_indices: [0, 1], confidence: 0.95, reason: 'Gleiche Schachtel' },
        { label: 'Adidas Jacke', image_indices: [2, 3], confidence: 0.82, reason: 'Andere Marke' },
      ],
    });
    const result = parseGroupingResponse(response, 4);
    expect(result).toHaveLength(2);
    expect(result[0].label).toBe('Nike Schuh');
    expect(result[0].image_indices).toEqual([0, 1]);
    expect(result[1].confidence).toBe(0.82);
  });

  it('extracts JSON from markdown code block', () => {
    const response = '```json\n{"product_count": 1, "groups": [{"label": "Produkt 1", "image_indices": [0, 1], "confidence": 0.9}]}\n```';
    const result = parseGroupingResponse(response, 2);
    expect(result).toHaveLength(1);
    expect(result[0].image_indices).toEqual([0, 1]);
  });

  it('filters out invalid indices (>= imageCount)', () => {
    const response = JSON.stringify({
      groups: [{ label: 'P1', image_indices: [0, 1, 5, 99], confidence: 0.8 }],
    });
    const result = parseGroupingResponse(response, 3);
    expect(result[0].image_indices).toEqual([0, 1]);
  });

  it('removes empty groups after filtering', () => {
    const response = JSON.stringify({
      groups: [
        { label: 'P1', image_indices: [0], confidence: 0.9 },
        { label: 'P2', image_indices: [99], confidence: 0.5 }, // all invalid
      ],
    });
    const result = parseGroupingResponse(response, 2);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('P1');
  });

  it('clamps confidence to 0-1 range', () => {
    const response = JSON.stringify({
      groups: [{ label: 'P1', image_indices: [0], confidence: 1.5 }],
    });
    const result = parseGroupingResponse(response, 1);
    expect(result[0].confidence).toBe(1);
  });

  it('defaults confidence to 0.5 when missing', () => {
    const response = JSON.stringify({
      groups: [{ label: 'P1', image_indices: [0] }],
    });
    const result = parseGroupingResponse(response, 1);
    expect(result[0].confidence).toBe(0.5);
  });

  it('handles detected_barcode', () => {
    const response = JSON.stringify({
      groups: [
        { label: 'P1', image_indices: [0], confidence: 0.9, detected_barcode: '4006381333931' },
        { label: 'P2', image_indices: [1], confidence: 0.8, detected_barcode: null },
      ],
    });
    const result = parseGroupingResponse(response, 2);
    expect(result[0].detected_barcode).toBe('4006381333931');
    expect(result[1].detected_barcode).toBeNull();
  });

  it('provides default label when missing', () => {
    const response = JSON.stringify({
      groups: [{ image_indices: [0], confidence: 0.9 }],
    });
    const result = parseGroupingResponse(response, 1);
    expect(result[0].label).toBe('Produkt 1');
  });
});

// --- Multi-Product per shared photo (multi-image grouping) ---

describe('multi-product per shared photo', () => {
  it('prompt instructs separate groups per product on a shared photo with position hints', () => {
    const prompt = buildGroupingPrompt(4);
    expect(prompt).toContain('EIGENE Gruppe');
    expect(prompt).toContain('position_hint');
  });

  it('schema allows per-group hint fields', () => {
    const item = GROUPING_SCHEMA.properties.groups.items;
    expect(item.properties.position_hint.type).toBe('string');
    expect(item.properties.brand_hint.type).toBe('string');
    expect(item.properties.category_hint.type).toBe('string');
  });

  it('composes hint from brand/category/position fields', () => {
    const response = JSON.stringify({
      product_count: 2,
      groups: [
        { label: 'Nike Schuh', image_indices: [0], confidence: 0.9, brand_hint: 'Nike', category_hint: 'Schuhe', position_hint: 'oben links' },
        { label: 'Bosch Bohrer', image_indices: [0], confidence: 0.8, position_hint: 'rechts unten' },
      ],
    });
    const result = parseGroupingResponse(response, 1);
    expect(result[0].hint).toBe('Marke: Nike. Kategorie: Schuhe. Position: oben links');
    expect(result[1].hint).toBe('Position: rechts unten');
  });

  it('does not repeat the label inside hint (StepAnalysis prepends it already)', () => {
    const response = JSON.stringify({
      groups: [
        { label: 'Nike Schuh', image_indices: [0], confidence: 0.9, brand_hint: 'Nike' },
      ],
    });
    const result = parseGroupingResponse(response, 1);
    expect(result[0].hint).not.toContain('Nike Schuh');
  });

  it('nulls identical detected_barcode that appears in multiple groups (Falsch-Reuse guard)', () => {
    const response = JSON.stringify({
      groups: [
        { label: 'Bosch Bohrer', image_indices: [0], confidence: 0.9, detected_barcode: '4006381333931' },
        { label: 'Makita Schleifer', image_indices: [0], confidence: 0.8, detected_barcode: '4006381333931' },
        { label: 'Nike Schuh', image_indices: [1], confidence: 0.9, detected_barcode: '8806094961164' },
      ],
    });
    const result = parseGroupingResponse(response, 2);
    expect(result[0].detected_barcode).toBeNull();
    expect(result[1].detected_barcode).toBeNull();
    expect(result[2].detected_barcode).toBe('8806094961164');
  });

  it('prompt scopes barcodes to their own product group', () => {
    const prompt = buildGroupingPrompt(3);
    expect(prompt).toContain('NUR bei der Gruppe');
  });

  it('prompt keeps multiple units of the same product in ONE group', () => {
    const prompt = buildGroupingPrompt(3);
    expect(prompt).toContain('Exemplare desselben Produkts');
  });

  it('hint is null when no hint fields are present', () => {
    const response = JSON.stringify({
      groups: [{ label: 'P1', image_indices: [0], confidence: 0.9 }],
    });
    const result = parseGroupingResponse(response, 1);
    expect(result[0].hint).toBeNull();
  });

  it('keeps overlapping image_indices across groups (shared photo)', () => {
    const response = JSON.stringify({
      groups: [
        { label: 'A', image_indices: [0, 1], confidence: 0.9 },
        { label: 'B', image_indices: [0], confidence: 0.8 },
      ],
    });
    const result = parseGroupingResponse(response, 2);
    expect(result[0].image_indices).toEqual([0, 1]);
    expect(result[1].image_indices).toEqual([0]);
  });

  it('dedupes duplicate indices within one group', () => {
    const response = JSON.stringify({
      groups: [{ label: 'A', image_indices: [0, 0, 1], confidence: 0.9 }],
    });
    const result = parseGroupingResponse(response, 2);
    expect(result[0].image_indices).toEqual([0, 1]);
  });
});

// --- Multi-Product Detection Tests ---

describe('buildMultiProductPrompt', () => {
  it('mentions single image analysis', () => {
    const prompt = buildMultiProductPrompt();
    expect(prompt).toContain('1 einzelnes Bild');
  });

  it('includes max product limit', () => {
    const prompt = buildMultiProductPrompt();
    expect(prompt).toContain('10');
  });

  it('includes anti-hallucination rules', () => {
    const prompt = buildMultiProductPrompt();
    expect(prompt).toContain('Erfinde KEINE');
    expect(prompt).toContain('WENIGER Produkte');
  });

  it('instructs listing the same model exactly once (duplicate incident 2026-08-01)', () => {
    const prompt = buildMultiProductPrompt();
    expect(prompt).toContain('GENAU EINMAL');
  });

  it('instructs bounding_description', () => {
    const prompt = buildMultiProductPrompt();
    expect(prompt).toContain('bounding_description');
  });
});

describe('VISION_DETECTION_CONFIG', () => {
  it('has enough output budget for thinking models + 10-product JSON (MAX_TOKENS incident 2026-08-01)', () => {
    expect(VISION_DETECTION_CONFIG.maxOutputTokens).toBeGreaterThanOrEqual(4096);
  });
});

describe('GROUPING_SCHEMA', () => {
  it('has required fields for structured output', () => {
    expect(GROUPING_SCHEMA.type).toBe('object');
    expect(GROUPING_SCHEMA.required).toContain('product_count');
    expect(GROUPING_SCHEMA.required).toContain('groups');
    expect(GROUPING_SCHEMA.properties.groups.type).toBe('array');
  });

  it('uses integer for product_count', () => {
    expect(GROUPING_SCHEMA.properties.product_count.type).toBe('integer');
  });
});

describe('parseGroupingResponse with many groups (BUG-090)', () => {
  it('parses 15 groups from 22 images correctly', () => {
    const groups = Array.from({ length: 15 }, (_, i) => ({
      label: `Produkt ${i + 1}`,
      image_indices: [i, i + 1 < 22 ? i + 1 : i],
      confidence: 0.85,
      reason: `Gruppe ${i + 1}`,
    }));
    const raw = JSON.stringify({ product_count: 15, groups });
    const result = parseGroupingResponse(raw, 22);
    expect(result).toHaveLength(15);
    expect(result[14].label).toBe('Produkt 15');
  });

  it('handles each image in its own group', () => {
    const groups = Array.from({ length: 10 }, (_, i) => ({
      label: `Item ${i + 1}`,
      image_indices: [i],
      confidence: 0.7,
    }));
    const raw = JSON.stringify({ product_count: 10, groups });
    const result = parseGroupingResponse(raw, 10);
    expect(result).toHaveLength(10);
  });
});

describe('parseDetectionResponse', () => {
  it('parses valid detection JSON with multiple products', () => {
    const raw = JSON.stringify({
      product_count: 3,
      products: [
        { label: 'Nike Schuh', confidence: 0.9, brand_hint: 'Nike', bounding_description: 'links oben' },
        { label: 'Adidas Jacke', confidence: 0.7, category_hint: 'Kleidung', bounding_description: 'Mitte' },
        { label: 'Bosch Bohrer', confidence: 0.5, barcode_hint: '4006381333931', bounding_description: 'rechts unten' },
      ],
    });
    const result = parseDetectionResponse(raw);
    expect(result).toHaveLength(3);
    expect(result[0].label).toBe('Nike Schuh');
    expect(result[0].brand_hint).toBe('Nike');
    expect(result[0].bounding_description).toBe('links oben');
    expect(result[1].category_hint).toBe('Kleidung');
    expect(result[2].barcode_hint).toBe('4006381333931');
  });

  it('parses single product', () => {
    const raw = JSON.stringify({
      product_count: 1,
      products: [{ label: 'Einzelprodukt', confidence: 0.95 }],
    });
    const result = parseDetectionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Einzelprodukt');
  });

  it('clamps confidence to 0-1', () => {
    const raw = JSON.stringify({
      product_count: 1,
      products: [{ label: 'X', confidence: 2.5 }],
    });
    const result = parseDetectionResponse(raw);
    expect(result[0].confidence).toBe(1);
  });

  it('defaults confidence to 0.5 when missing', () => {
    const raw = JSON.stringify({
      product_count: 1,
      products: [{ label: 'X' }],
    });
    const result = parseDetectionResponse(raw);
    expect(result[0].confidence).toBe(0.5);
  });

  it('enforces max 10 products', () => {
    const products = Array.from({ length: 15 }, (_, i) => ({
      label: `P${i}`,
      confidence: 0.8,
    }));
    const raw = JSON.stringify({ product_count: 15, products });
    const result = parseDetectionResponse(raw);
    expect(result).toHaveLength(10);
  });

  it('filters out products with empty labels', () => {
    const raw = JSON.stringify({
      product_count: 2,
      products: [
        { label: 'Gutes Produkt', confidence: 0.9 },
        { label: '', confidence: 0.8 },
        { label: '  ', confidence: 0.7 },
      ],
    });
    const result = parseDetectionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Gutes Produkt');
  });

  it('returns empty array on invalid JSON', () => {
    expect(parseDetectionResponse('not json at all')).toEqual([]);
  });

  it('returns empty array when products is not an array', () => {
    const raw = JSON.stringify({ product_count: 1, products: 'bad' });
    expect(parseDetectionResponse(raw)).toEqual([]);
  });

  it('strips markdown fences', () => {
    const raw = '```json\n{"product_count":1,"products":[{"label":"Test","confidence":0.9}]}\n```';
    const result = parseDetectionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Test');
  });

  it('defaults missing hint fields to empty strings', () => {
    const raw = JSON.stringify({
      product_count: 1,
      products: [{ label: 'Minimal', confidence: 0.8 }],
    });
    const result = parseDetectionResponse(raw);
    expect(result[0].brand_hint).toBe('');
    expect(result[0].category_hint).toBe('');
    expect(result[0].barcode_hint).toBe('');
    expect(result[0].bounding_description).toBe('');
  });

  it('dedupes products sharing the same model number token (Prod 2026-08-01: TV 3x gelistet)', () => {
    const raw = JSON.stringify({
      product_count: 4,
      products: [
        { label: 'Philips 40PFS6000/12 (40 Zoll)', confidence: 0.7, bounding_description: 'oben links' },
        { label: 'Philips 40PFS6000/12 Smart TV', confidence: 0.9, brand_hint: 'Philips' },
        { label: 'Krups Virtuoso XP442C Espresso', confidence: 0.85 },
        { label: 'Philips 40PFS6000/12 Smart TV 40"', confidence: 0.6 },
      ],
    });
    const result = parseDetectionResponse(raw);
    expect(result).toHaveLength(2);
    const labels = result.map((p) => p.label);
    expect(labels).toContain('Philips 40PFS6000/12 Smart TV');
    expect(labels).toContain('Krups Virtuoso XP442C Espresso');
    // Duplikat mit höchster Confidence gewinnt
    expect(result.find((p) => p.label.includes('Philips')).confidence).toBe(0.9);
  });

  it('dedupes products with split model tokens like "KF 1500"', () => {
    const raw = JSON.stringify({
      product_count: 2,
      products: [
        { label: 'Braun PurShine KF 1500 BK', confidence: 0.8 },
        { label: 'Braun KF 1500 Kaffeemaschine', confidence: 0.7 },
      ],
    });
    const result = parseDetectionResponse(raw);
    expect(result).toHaveLength(1);
  });

  it('dedupes products sharing the same barcode_hint', () => {
    const raw = JSON.stringify({
      product_count: 2,
      products: [
        { label: 'Produkt A', confidence: 0.8, barcode_hint: '4006381333931' },
        { label: 'Produkt B anders benannt', confidence: 0.7, barcode_hint: '4006381333931' },
      ],
    });
    const result = parseDetectionResponse(raw);
    expect(result).toHaveLength(1);
  });

  it('keeps genuinely different products untouched', () => {
    const raw = JSON.stringify({
      product_count: 3,
      products: [
        { label: 'Tineco Floor One S3', confidence: 0.9 },
        { label: 'Krups Virtuoso XP442C', confidence: 0.85 },
        { label: 'Braun PurShine KF 1500', confidence: 0.8 },
      ],
    });
    const result = parseDetectionResponse(raw);
    expect(result).toHaveLength(3);
  });

  it('merges hint fields from dropped duplicates into the kept entry', () => {
    const raw = JSON.stringify({
      product_count: 2,
      products: [
        { label: 'Philips 40PFS6000/12', confidence: 0.9 },
        { label: 'Philips 40PFS6000/12 TV', confidence: 0.6, barcode_hint: '8718863016838', brand_hint: 'Philips' },
      ],
    });
    const result = parseDetectionResponse(raw);
    expect(result).toHaveLength(1);
    expect(result[0].confidence).toBe(0.9);
    expect(result[0].barcode_hint).toBe('8718863016838');
    expect(result[0].brand_hint).toBe('Philips');
  });

  it('repairs truncated JSON (MAX_TOKENS) and salvages complete products', () => {
    // Prod-Fehlerbild 2026-08-01: finishReason=MAX_TOKENS schnitt das JSON
    // mitten im dritten Produkt ab — vorher ging die GESAMTE Erkennung verloren.
    const truncated = '{"product_count": 3, "products": [{"label": "Nike Schuh", "confidence": 0.9}, {"label": "Bosch Bohrer", "confidence": 0.8}, {"label": "Maki';
    const result = parseDetectionResponse(truncated);
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(result[0].label).toBe('Nike Schuh');
    expect(result[1].label).toBe('Bosch Bohrer');
  });

  it('assigns sequential IDs', () => {
    const raw = JSON.stringify({
      product_count: 2,
      products: [
        { label: 'A', confidence: 0.9 },
        { label: 'B', confidence: 0.8 },
      ],
    });
    const result = parseDetectionResponse(raw);
    expect(result[0].id).toBe('detected_0');
    expect(result[1].id).toBe('detected_1');
  });
});
