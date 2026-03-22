/**
 * Tests for extractWeightFromTitle (TEIL 5: Gewichtsschätzung).
 *
 * The function is exported via enrichment.__test.extractWeightFromTitle.
 * Since enrichment.js has heavy dependencies (Gemini API, Firestore, etc.),
 * we patch GCP and key local modules before importing.
 */

// ─── Patch GCP so enrichment.js can load ────────────────────────────────────
require('./api/_patchGcp');

// Patch local modules that enrichment.js requires at startup
const path = require('path');

function stubModule(modPath, exports) {
  try {
    const resolved = require.resolve(modPath);
    require.cache[resolved] = {
      id: resolved, filename: resolved, loaded: true,
      exports, children: [], paths: [],
    };
  } catch { /* not found — skip */ }
}

// Minimal stubs for enrichment.js imports
stubModule('../lib/firestore', {
  getProduct: vi.fn(), findProductByStrictIdentifier: vi.fn(),
  adjustPendingIntakeQuantity: vi.fn(), firestore: {},
});
stubModule('../lib/product-store', { saveProductV2: vi.fn() });
stubModule('../lib/product-identity', {
  buildIdentityAliasSet: vi.fn(() => []),
  computeProductIdentityKey: vi.fn(() => ''),
  sanitizeIdentityValue: vi.fn((v) => v),
});
stubModule('../lib/secret-values', { getSecretValue: vi.fn().mockResolvedValue('') });
stubModule('../lib/ebay-taxonomy', {
  findEbayCategory: vi.fn(), getEbayRequiredAspects: vi.fn(() => []),
  getCategoryAspectCatalog: vi.fn(), getEbayCategoryAspectCatalog: vi.fn(),
  getEbayCategories: vi.fn(() => ({})),
});
stubModule('../lib/ebay-category-governance', { isBannedEbayBreadcrumb: vi.fn(() => false) });
stubModule('../lib/price-enrichment', { enrichPriceForProductBestEffort: vi.fn() });
stubModule('../lib/web-unlocker', { fetchWithUnlocker: vi.fn() });
stubModule('../lib/gpsr-manufacturer-registry', {
  getManufacturerGpsrByName: vi.fn(), upsertManufacturerGpsr: vi.fn(),
  mergePreferMoreComplete: vi.fn(), normalizeGpsrObject: vi.fn((v) => v),
  normalizeCountryCode: vi.fn((v) => v), normalizeGpsrPhone: vi.fn((v) => v),
});
stubModule('../lib/storage', { uploadBase64Image: vi.fn(), deleteProductImages: vi.fn() });
stubModule('../lib/html-entities', { decodeHtmlEntitiesDeep: vi.fn((v) => v) });
stubModule('../lib/title-policy', { coerceTitleToPolicy: vi.fn((v) => v) });
stubModule('../lib/brand-normalize', { normalizeBrandDisplayCase: vi.fn((v) => v) });
stubModule('../lib/vehicle-fitment', { getVehicleFitmentMode: vi.fn(() => null) });
stubModule('../lib/gtin', { isValidGtin: vi.fn(() => false), normalizeDigits: vi.fn((v) => v) });
stubModule('../lib/sku', { generateSku: vi.fn(() => 'TST-001') });

// Now load the function under test
const { __test } = require('../services/enrichment');
const { extractWeightFromTitle } = __test;

// ─── Tests ──────────────────────────────────────────────────────────────────
describe('extractWeightFromTitle', () => {
  it('extracts kg from title', () => {
    expect(extractWeightFromTitle('Costway Elektro-Quad 12V 35kg')).toBe(35);
  });

  it('extracts grams and converts to kg', () => {
    expect(extractWeightFromTitle('Smartphone Hülle 50g')).toBeCloseTo(0.05);
  });

  it('returns null when no weight in title', () => {
    expect(extractWeightFromTitle('Werkzeugset 3-teilig')).toBeNull();
  });

  it('handles comma decimal separator', () => {
    expect(extractWeightFromTitle('Paket 2,5 kg Mehl')).toBe(2.5);
  });

  it('handles "Kilogramm" unit', () => {
    expect(extractWeightFromTitle('Hundefutter 10 Kilogramm')).toBe(10);
  });

  it('handles "gramm" unit', () => {
    expect(extractWeightFromTitle('Gewürz 250 Gramm')).toBeCloseTo(0.25);
  });

  it('returns null for null/undefined input', () => {
    expect(extractWeightFromTitle(null)).toBeNull();
    expect(extractWeightFromTitle(undefined)).toBeNull();
    expect(extractWeightFromTitle('')).toBeNull();
  });
});
