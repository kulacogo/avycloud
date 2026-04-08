/**
 * Unit tests for batch-optimize service.
 *
 * Tests the pure logic functions (filter, apply) without Firestore or Gemini.
 * describe/it/expect are provided globally by Vitest (globals: true in config).
 */

// The functions under test are pure logic — no GCP/Gemini deps needed.
const {
  hasBinAssignment,
  isNotListedOnEbay,
  isEligibleForBatchOptimize,
  applyChangesToProduct,
} = require('../services/batch-optimize');

// ---------------------------------------------------------------------------
// hasBinAssignment
// ---------------------------------------------------------------------------

describe('hasBinAssignment', () => {
  it('returns true when product has storage.binCode', () => {
    const product = { id: 'p1', storage: { binCode: 'X-5-GA-3-1' } };
    expect(hasBinAssignment(product)).toBe(true);
  });

  it('returns true when product has storageBins with binCode', () => {
    const product = { id: 'p2', storageBins: [{ binCode: 'S-2-EG-1-3', quantity: 5 }] };
    expect(hasBinAssignment(product)).toBe(true);
  });

  it('returns false when product has no storage at all', () => {
    const product = { id: 'p3' };
    expect(hasBinAssignment(product)).toBe(false);
  });

  it('returns false when storageBins is empty array', () => {
    const product = { id: 'p4', storageBins: [] };
    expect(hasBinAssignment(product)).toBe(false);
  });

  it('returns false when storage has no binCode', () => {
    const product = { id: 'p5', storage: { zone: 'X' } };
    expect(hasBinAssignment(product)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isNotListedOnEbay
// ---------------------------------------------------------------------------

describe('isNotListedOnEbay', () => {
  it('returns true when no listingStatus at all', () => {
    const product = { id: 'p1', ops: {} };
    expect(isNotListedOnEbay(product)).toBe(true);
  });

  it('returns true when ebay status is "not_listed"', () => {
    const product = { id: 'p2', ops: { listingStatus: { ebay: 'not_listed' } } };
    expect(isNotListedOnEbay(product)).toBe(true);
  });

  it('returns false when ebay status is "active"', () => {
    const product = { id: 'p3', ops: { listingStatus: { ebay: 'active' } } };
    expect(isNotListedOnEbay(product)).toBe(false);
  });

  it('returns false when ebay status is "inactive"', () => {
    const product = { id: 'p4', ops: { listingStatus: { ebay: 'inactive' } } };
    expect(isNotListedOnEbay(product)).toBe(false);
  });

  it('returns true when ops is undefined', () => {
    const product = { id: 'p5' };
    expect(isNotListedOnEbay(product)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isEligibleForBatchOptimize
// ---------------------------------------------------------------------------

describe('isEligibleForBatchOptimize', () => {
  it('returns true: has BIN + not on eBay', () => {
    const product = {
      id: 'p1',
      storage: { binCode: 'X-5-GA-3-1' },
      ops: { listingStatus: { ebay: 'not_listed' } },
    };
    expect(isEligibleForBatchOptimize(product)).toBe(true);
  });

  it('returns false: has BIN + active on eBay', () => {
    const product = {
      id: 'p2',
      storage: { binCode: 'X-5-GA-3-1' },
      ops: { listingStatus: { ebay: 'active' } },
    };
    expect(isEligibleForBatchOptimize(product)).toBe(false);
  });

  it('returns false: no BIN + not on eBay', () => {
    const product = {
      id: 'p3',
      ops: { listingStatus: { ebay: 'not_listed' } },
    };
    expect(isEligibleForBatchOptimize(product)).toBe(false);
  });

  it('returns false: no product id', () => {
    const product = { storage: { binCode: 'X-1-GA-1-1' } };
    expect(isEligibleForBatchOptimize(product)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyChangesToProduct
// ---------------------------------------------------------------------------

describe('applyChangesToProduct', () => {
  const baseProduct = {
    id: 'test-123',
    identification: {
      name: 'Old Title',
      brand: 'OldBrand',
      category: 'Old Category',
      sku: 'SKU-001',
      barcodes: ['4006381333931'],
    },
    details: {
      short_description: '<p>Old description</p>',
      key_features: ['Old feature 1'],
      attributes: { Farbe: 'Schwarz' },
      gpsr: { manufacturer_name: 'OldManufacturer' },
      pricing: { lowest_price: { amount: 10 } },
    },
    notes: { unsure: [], warnings: [] },
  };

  it('applies title change', () => {
    const result = applyChangesToProduct(baseProduct, { title: 'New Title' });
    expect(result.identification.name).toBe('New Title');
  });

  it('applies identity changes (name, brand, category)', () => {
    const result = applyChangesToProduct(baseProduct, {
      identity: { name: 'Better Title', brand: 'NewBrand', category: 'Electronics > Chargers' },
    });
    expect(result.identification.name).toBe('Better Title');
    expect(result.identification.brand).toBe('NewBrand');
    expect(result.identification.category).toBe('Electronics > Chargers');
  });

  it('applies short_description', () => {
    const result = applyChangesToProduct(baseProduct, {
      short_description: '<p>New description</p>',
    });
    expect(result.details.short_description).toBe('<p>New description</p>');
  });

  it('applies key_features', () => {
    const result = applyChangesToProduct(baseProduct, {
      key_features: ['Feature A', 'Feature B'],
    });
    expect(result.details.key_features).toEqual(['Feature A', 'Feature B']);
  });

  it('merges GPSR data', () => {
    const result = applyChangesToProduct(baseProduct, {
      gpsr: { email: 'test@example.com' },
    });
    expect(result.details.gpsr.manufacturer_name).toBe('OldManufacturer');
    expect(result.details.gpsr.email).toBe('test@example.com');
  });

  it('merges attributes (object format)', () => {
    const result = applyChangesToProduct(baseProduct, {
      attributes: { Material: 'Kunststoff', Gewicht: '200g' },
    });
    expect(result.details.attributes.Farbe).toBe('Schwarz');
    expect(result.details.attributes.Material).toBe('Kunststoff');
    expect(result.details.attributes.Gewicht).toBe('200g');
  });

  it('filters out marketplace keys from attributes', () => {
    const result = applyChangesToProduct(baseProduct, {
      attributes: { Material: 'Kunststoff', 'eBay Kategorie': 'ignore' },
    });
    expect(result.details.attributes.Material).toBe('Kunststoff');
    expect(result.details.attributes['eBay Kategorie']).toBeUndefined();
  });

  it('merges pricing', () => {
    const result = applyChangesToProduct(baseProduct, {
      pricing: { lowest_price: { amount: 15, currency: 'EUR' } },
    });
    expect(result.details.pricing.lowest_price.amount).toBe(15);
    expect(result.details.pricing.lowest_price.currency).toBe('EUR');
  });

  it('does not mutate original product', () => {
    const original = JSON.parse(JSON.stringify(baseProduct));
    applyChangesToProduct(baseProduct, { title: 'Changed' });
    expect(baseProduct.identification.name).toBe(original.identification.name);
  });

  it('handles null/undefined change gracefully', () => {
    const result = applyChangesToProduct(baseProduct, null);
    expect(result.identification.name).toBe('Old Title');
  });

  it('applies categoryId to details', () => {
    const result = applyChangesToProduct(baseProduct, {
      categoryId: '12345',
    });
    expect(result.details.categoryId).toBe('12345');
  });
});
