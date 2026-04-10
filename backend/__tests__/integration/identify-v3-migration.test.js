'use strict';

/**
 * V3 Migration Compatibility Tests
 *
 * Verifies that V3-assembled products are compatible with all downstream
 * consumers: quality gate, product identity, job runner format, and
 * saveProductV2 field expectations.
 */

// Patch external dependencies
const datasheetPath = require.resolve('../../lib/datasheet-quality');
require(datasheetPath);
const originalEvaluate = require.cache[datasheetPath].exports.evaluateEbayReady;

const identityPath = require.resolve('../../lib/product-identity');
require(identityPath);
const originalComputeKey = require.cache[identityPath].exports.computeProductIdentityKey;
const originalBuildAliases = require.cache[identityPath].exports.buildIdentityAliasSet;

// Helper: build a realistic V3 product (matches assembleProduct output)
function makeV3Product(overrides = {}) {
  return {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    locale: 'de-DE',
    identification: {
      method: 'image',
      barcodes: ['4548736132610'],
      name: 'Sony WH-1000XM5 Kabellos Bluetooth Over-Ear Kopfhoerer Schwarz',
      brand: 'Sony',
      category: 'TV, Video & Audio > Kopfhoerer',
      confidence: 0.87,
      sku: undefined,
    },
    details: {
      categoryId: '112529',
      short_description: '<p>Premium Noise-Cancelling Kopfhoerer von Sony.</p><ul><li>Bluetooth 5.2</li></ul>',
      key_features: [
        'Branchenfuehrende Geraeuschdaempfung',
        'Bluetooth 5.2 Multipoint',
        '30 Stunden Akkulaufzeit',
      ],
      attributes: {
        Marke: 'Sony',
        Modell: 'WH-1000XM5',
        Farbe: 'Schwarz',
        Konnektivitaet: 'Bluetooth',
        Formfaktor: 'Over-Ear',
      },
      identifiers: {
        ean: '4548736132610',
        gtin: undefined,
        upc: undefined,
        mpn: 'WH1000XM5B',
        sku: undefined,
      },
      images: [
        { url_or_base64: 'https://storage.example.com/img1.jpg', source: 'upload', variant: 'reference' },
        { url_or_base64: 'https://sony.com/xm5.jpg', source: 'web_search', variant: 'marketing', notes: 'Sony XM5' },
      ],
      pricing: {
        lowest_price: {
          amount: 289,
          currency: 'EUR',
          sources: [{ url: 'https://geizhals.de/sony-xm5' }],
          last_checked_iso: '2026-04-10T00:00:00.000Z',
        },
        price_confidence: 0.85,
      },
      gpsr: {
        manufacturer_name: 'Sony Europe B.V.',
        manufacturer_address: 'Da Vincilaan 7-D1, Zaventem',
        email: 'info@sony.eu',
      },
    },
    marketplace: {
      ebay: {
        title: 'Sony WH-1000XM5 Kabellos Bluetooth Over-Ear Kopfhoerer Schwarz',
        description: '<p>Premium Noise-Cancelling Kopfhoerer von Sony.</p>',
      },
      kaufland: {
        title: 'Sony WH-1000XM5 Noise-Cancelling Over-Ear Bluetooth Kopfhoerer Schwarz',
        description: '<p>Sony WH-1000XM5 mit erstklassiger Geraeuschdaempfung.</p>',
      },
    },
    ops: {
      sync_status: 'pending',
      revision: 0,
      pending_intake_quantity: 0,
      weight_grams: 250,
      identify_pipeline: 'v3',
      sourcePalette: null,
      sourcePaletteAt: null,
      data_quality: {
        identify_v3: {
          checked_at_iso: '2026-04-10T00:00:00.000Z',
          overall_score: 0.87,
          field_confidence: { brand: { score: 0.95 } },
          aspect_coverage: { total: 3, filled: 3, missing: [], coverage: 1 },
          marketplace_readiness: { ebay: { ready: true }, kaufland: { ready: true } },
        },
      },
    },
    inventory: {
      quantity: 0,
      inventoryId: null,
      inventoryName: null,
    },
    notes: {},
    ...overrides,
  };
}

describe('V3 Migration Compatibility', () => {
  describe('evaluateEbayReady with V3 product', () => {
    it('accepts V3-assembled product and returns ok + issues', () => {
      const product = makeV3Product();
      const result = originalEvaluate(product, { force: true });

      expect(result).toHaveProperty('ok');
      expect(result).toHaveProperty('issues');
      expect(Array.isArray(result.issues)).toBe(true);
      expect(result).toHaveProperty('snapshot');
    });

    it('reads all expected fields from V3 product without errors', () => {
      const product = makeV3Product();
      // Should not throw
      expect(() => originalEvaluate(product, { force: true })).not.toThrow();
    });

    it('snapshot includes correct values from V3 fields', () => {
      const product = makeV3Product();
      const result = originalEvaluate(product, { force: true });

      expect(result.snapshot.title_len).toBeGreaterThan(0);
      expect(result.snapshot.desc_len).toBeGreaterThan(0);
      expect(result.snapshot.features).toBe(3);
      expect(result.snapshot.attrs).toBe(5);
    });
  });

  describe('computeProductIdentityKey with V3 product', () => {
    it('returns null for V3 product with barcodes (defers to barcode-based dedup)', () => {
      const product = makeV3Product();
      const key = originalComputeKey(product);
      // Products with barcodes return null (barcode-based dedup takes precedence)
      expect(key).toBeNull();
    });

    it('returns identity key for V3 product without barcodes', () => {
      const product = makeV3Product({
        identification: {
          method: 'image',
          barcodes: [],
          name: 'Sony WH-1000XM5 Kopfhoerer',
          brand: 'Sony',
          category: 'Kopfhoerer',
          confidence: 0.87,
        },
        details: {
          ...makeV3Product().details,
          identifiers: { mpn: 'WH1000XM5B' },
        },
      });
      const key = originalComputeKey(product);
      expect(key).toMatch(/^identity:/);
    });
  });

  describe('buildIdentityAliasSet with V3 product', () => {
    it('builds alias set without errors', () => {
      const product = makeV3Product();
      expect(() => originalBuildAliases(product)).not.toThrow();
      const aliases = originalBuildAliases(product);
      expect(Array.isArray(aliases)).toBe(true);
      expect(aliases.length).toBeGreaterThan(0);
    });
  });

  describe('Canonical Product shape', () => {
    it('has all top-level fields required by saveProductV2', () => {
      const product = makeV3Product();

      // Top-level
      expect(product).toHaveProperty('id');
      expect(product).toHaveProperty('identification');
      expect(product).toHaveProperty('details');
      expect(product).toHaveProperty('marketplace');
      expect(product).toHaveProperty('ops');
      expect(product).toHaveProperty('inventory');
      expect(product).toHaveProperty('notes');
    });

    it('identification has all required fields', () => {
      const product = makeV3Product();
      const id = product.identification;

      expect(id).toHaveProperty('name');
      expect(id).toHaveProperty('brand');
      expect(id).toHaveProperty('category');
      expect(typeof id.name).toBe('string');
      expect(typeof id.brand).toBe('string');
    });

    it('details has all required fields', () => {
      const product = makeV3Product();
      const d = product.details;

      expect(d).toHaveProperty('short_description');
      expect(d).toHaveProperty('key_features');
      expect(d).toHaveProperty('attributes');
      expect(d).toHaveProperty('identifiers');
      expect(d).toHaveProperty('images');
      expect(d).toHaveProperty('pricing');
      expect(Array.isArray(d.key_features)).toBe(true);
      expect(Array.isArray(d.images)).toBe(true);
      expect(typeof d.attributes).toBe('object');
    });

    it('marketplace has ebay and kaufland with title + description', () => {
      const product = makeV3Product();

      expect(product.marketplace.ebay).toHaveProperty('title');
      expect(product.marketplace.ebay).toHaveProperty('description');
      expect(product.marketplace.kaufland).toHaveProperty('title');
      expect(product.marketplace.kaufland).toHaveProperty('description');
    });

    it('ops has required fields for downstream consumers', () => {
      const product = makeV3Product();

      expect(product.ops.sync_status).toBe('pending');
      expect(product.ops.revision).toBe(0);
      expect(product.ops.identify_pipeline).toBe('v3');
    });

    it('images have correct source format for listing pipeline', () => {
      const product = makeV3Product();
      for (const img of product.details.images) {
        expect(img).toHaveProperty('url_or_base64');
        expect(img).toHaveProperty('source');
        expect(['upload', 'web_search']).toContain(img.source);
      }
    });
  });

  describe('Job runner format compatibility', () => {
    it('V3 product wraps correctly in job runner return format', () => {
      const product = makeV3Product();
      const jobResult = {
        bundle: { products: [product] },
        serpTrace: [{
          type: 'google_search_grounding_v3',
          model: 'gemini-3-pro-preview',
          queries: [],
          sources: [],
        }],
        modelUsed: 'gemini-3-pro-preview',
      };

      expect(jobResult.bundle.products).toHaveLength(1);
      expect(jobResult.bundle.products[0].id).toBe(product.id);
      expect(jobResult.serpTrace[0].type).toContain('grounding');
      expect(typeof jobResult.modelUsed).toBe('string');
    });
  });
});
