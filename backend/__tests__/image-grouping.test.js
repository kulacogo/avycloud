/**
 * Tests for image-grouping service — parseGroupingResponse & buildGroupingPrompt.
 */
const {
  buildGroupingPrompt,
  parseGroupingResponse,
  buildMultiProductPrompt,
  parseDetectionResponse,
} = require('../services/image-grouping');

describe('buildGroupingPrompt', () => {
  it('includes image count in prompt', () => {
    const prompt = buildGroupingPrompt(5);
    expect(prompt).toContain('5 Bilder');
  });

  it('includes anti-hallucination rules', () => {
    const prompt = buildGroupingPrompt(3);
    expect(prompt).toContain('Erfinde KEINE Produkte');
    expect(prompt).toContain('Im Zweifel: alles in EINE Gruppe');
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

  it('instructs bounding_description', () => {
    const prompt = buildMultiProductPrompt();
    expect(prompt).toContain('bounding_description');
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
