/**
 * Tests for image-grouping service — parseGroupingResponse & buildGroupingPrompt.
 */
const { buildGroupingPrompt, parseGroupingResponse } = require('../services/image-grouping');

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
