const { validateForMarketplace, validateProduct, SUPPORTED_MARKETPLACES } = require('./listing-validator');

// ── Helper: minimal valid product ──

function makeProduct(overrides = {}) {
  const base = {
    id: 'test-123',
    identification: {
      name: 'Bosch Bremsscheibe vorne 280mm fuer VW Golf 7 Audi A3',
      brand: 'Bosch',
      category: 'Auto & Motorrad: Teile > Bremsanlage > Bremsscheiben',
      barcodes: ['4047024411234'],
      confidence: 0.95,
    },
    details: {
      short_description: 'Hochwertige Bremsscheibe von Bosch fuer VW Golf 7 und Audi A3. Durchmesser 280mm, belueftet. Passend fuer alle Modelljahre 2012-2024. OE-Qualitaet mit ABE-Zulassung.',
      key_features: [
        'Durchmesser 280mm belueftet',
        'OE-Qualitaet',
        'ABE-Zulassung',
        'Passend fuer VW Golf 7',
        'Passend fuer Audi A3',
      ],
      categoryId: '33726',
      images: [
        { url_or_base64: 'https://example.com/img1.jpg', source: 'upload', variant: 'front', notes: '' },
        { url_or_base64: 'https://example.com/img2.jpg', source: 'upload', variant: 'angle', notes: '' },
        { url_or_base64: 'https://example.com/img3.jpg', source: 'upload', variant: 'detail', notes: '' },
      ],
      identifiers: {
        ean: '4047024411234',
        gtin: null,
        upc: null,
        mpn: '0986479C60',
        sku: 'BSH-BRK-280',
      },
      attributes: {
        'Marke': 'Bosch',
        'Herstellernummer': '0986479C60',
        'Referenznummer(n) OE': '5Q0615301F',
        'Einbauposition': 'Vorne',
        'Oberflaechenbeschaffenheit': 'Belueftet',
        'Durchmesser': '280mm',
      },
      pricing: {
        lowest_price: { amount: 29.99, currency: 'EUR', sources: [{ name: 'eBay', url: 'https://ebay.de/...', price: 29.99, shipping: 0, checked_at: '2026-03-19' }], last_checked_iso: '2026-03-19' },
        price_confidence: 0.85,
        sellPrice: 34.99,
      },
    },
    ops: {},
    notes: {},
  };
  return JSON.parse(JSON.stringify({ ...base, ...overrides }));
}

describe('listing-validator', () => {
  describe('SUPPORTED_MARKETPLACES', () => {
    it('should include ebay and kaufland', () => {
      expect(SUPPORTED_MARKETPLACES).toContain('ebay');
      expect(SUPPORTED_MARKETPLACES).toContain('kaufland');
    });
  });

  describe('validateForMarketplace — eBay', () => {
    it('should return score 100 for fully valid product', () => {
      const product = makeProduct();
      const result = validateForMarketplace(product, 'ebay');
      expect(result.marketplace).toBe('ebay');
      expect(result.ready).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.score).toBeGreaterThanOrEqual(90);
    });

    it('should return errors for product missing title', () => {
      const product = makeProduct();
      product.identification.name = '';
      const result = validateForMarketplace(product, 'ebay');
      expect(result.ready).toBe(false);
      expect(result.errors.some((e) => e.code === 'title_missing')).toBe(true);
    });

    it('should return errors for title over 80 chars', () => {
      const product = makeProduct();
      product.identification.name = 'A'.repeat(85);
      const result = validateForMarketplace(product, 'ebay');
      expect(result.errors.some((e) => e.code === 'title_too_long')).toBe(true);
    });

    it('should return errors for product missing images', () => {
      const product = makeProduct();
      product.details.images = [];
      const result = validateForMarketplace(product, 'ebay');
      expect(result.ready).toBe(false);
      expect(result.errors.some((e) => e.code === 'images_missing')).toBe(true);
    });

    it('should return errors for missing category', () => {
      const product = makeProduct();
      product.details.categoryId = '';
      const result = validateForMarketplace(product, 'ebay');
      expect(result.ready).toBe(false);
      expect(result.errors.some((e) => e.code === 'category_missing')).toBe(true);
    });

    it('should return warning for missing EAN', () => {
      const product = makeProduct();
      product.details.identifiers.ean = null;
      product.details.identifiers.gtin = null;
      product.identification.barcodes = [];
      const result = validateForMarketplace(product, 'ebay');
      expect(result.warnings.some((w) => w.code === 'ean_missing')).toBe(true);
    });

    it('should return warning for invalid EAN format', () => {
      const product = makeProduct();
      product.details.identifiers.ean = '12345';
      product.details.identifiers.gtin = null;
      product.identification.barcodes = [];
      const result = validateForMarketplace(product, 'ebay');
      expect(result.warnings.some((w) => w.code === 'ean_invalid')).toBe(true);
    });

    it('should return warning for missing brand', () => {
      const product = makeProduct();
      product.identification.brand = '';
      const result = validateForMarketplace(product, 'ebay');
      expect(result.warnings.some((w) => w.code === 'brand_missing')).toBe(true);
    });

    it('should return warning for short title', () => {
      const product = makeProduct();
      product.identification.name = 'Bremsscheibe Bosch';
      const result = validateForMarketplace(product, 'ebay');
      expect(result.warnings.some((w) => w.code === 'title_short')).toBe(true);
    });

    it('should return info for few images', () => {
      const product = makeProduct();
      product.details.images = [
        { url_or_base64: 'https://example.com/img1.jpg', source: 'upload', variant: 'front', notes: '' },
      ];
      const result = validateForMarketplace(product, 'ebay');
      expect(result.info.some((i) => i.code === 'few_images')).toBe(true);
    });

    it('should return info for few key features', () => {
      const product = makeProduct();
      product.details.key_features = ['Feature 1'];
      const result = validateForMarketplace(product, 'ebay');
      expect(result.info.some((i) => i.code === 'few_features')).toBe(true);
    });

    it('should detect active content in description', () => {
      const product = makeProduct();
      product.details.short_description = '<script>alert("xss")</script>A valid description text here that is long enough.';
      const result = validateForMarketplace(product, 'ebay');
      expect(result.errors.some((e) => e.code === 'description_active_content')).toBe(true);
    });

    it('should detect off-eBay links in description', () => {
      const product = makeProduct();
      product.details.short_description = 'Besuchen Sie uns auf https://www.myshop.de fuer mehr! This is a description long enough.';
      const result = validateForMarketplace(product, 'ebay');
      expect(result.errors.some((e) => e.code === 'description_off_ebay_links')).toBe(true);
    });

    it('should have suggestion on every issue', () => {
      const product = makeProduct();
      product.identification.name = '';
      product.details.images = [];
      product.details.categoryId = '';
      const result = validateForMarketplace(product, 'ebay');
      for (const issue of [...result.errors, ...result.warnings, ...result.info]) {
        expect(issue.suggestion).toBeTruthy();
      }
    });
  });

  describe('validateForMarketplace — Kaufland', () => {
    it('should return score 100 for fully valid product', () => {
      const product = makeProduct();
      const result = validateForMarketplace(product, 'kaufland');
      expect(result.marketplace).toBe('kaufland');
      expect(result.ready).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.score).toBeGreaterThanOrEqual(90);
    });

    it('should return error for missing EAN (stricter than eBay)', () => {
      const product = makeProduct();
      product.details.identifiers.ean = null;
      product.details.identifiers.gtin = null;
      product.identification.barcodes = [];
      const result = validateForMarketplace(product, 'kaufland');
      expect(result.ready).toBe(false);
      expect(result.errors.some((e) => e.code === 'ean_missing')).toBe(true);
    });

    it('should return error for missing title', () => {
      const product = makeProduct();
      product.identification.name = '';
      const result = validateForMarketplace(product, 'kaufland');
      expect(result.errors.some((e) => e.code === 'title_missing')).toBe(true);
    });

    it('should return error for missing images', () => {
      const product = makeProduct();
      product.details.images = [];
      const result = validateForMarketplace(product, 'kaufland');
      expect(result.errors.some((e) => e.code === 'images_missing')).toBe(true);
    });

    it('should return warning for missing brand', () => {
      const product = makeProduct();
      product.identification.brand = '';
      const result = validateForMarketplace(product, 'kaufland');
      expect(result.warnings.some((w) => w.code === 'brand_missing')).toBe(true);
    });
  });

  describe('validateProduct — multi-marketplace', () => {
    it('should validate against both marketplaces by default', () => {
      const product = makeProduct();
      const results = validateProduct(product);
      expect(results).toHaveProperty('ebay');
      expect(results).toHaveProperty('kaufland');
      expect(results.ebay.marketplace).toBe('ebay');
      expect(results.kaufland.marketplace).toBe('kaufland');
    });

    it('should validate against specified marketplaces only', () => {
      const product = makeProduct();
      const results = validateProduct(product, ['ebay']);
      expect(results).toHaveProperty('ebay');
      expect(results).not.toHaveProperty('kaufland');
    });

    it('should throw for unknown marketplace', () => {
      const product = makeProduct();
      expect(() => validateProduct(product, ['amazon'])).toThrow('Unknown marketplace: amazon');
    });
  });

  describe('score calculation', () => {
    it('should clamp score to 0 minimum', () => {
      const product = makeProduct();
      product.identification.name = '';
      product.details.images = [];
      product.details.categoryId = '';
      product.details.short_description = '';
      product.identification.brand = '';
      product.details.identifiers.ean = null;
      product.details.identifiers.gtin = null;
      product.identification.barcodes = [];
      product.details.pricing = {};
      product.details.key_features = [];
      product.details.attributes = {};
      const result = validateForMarketplace(product, 'ebay');
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    });
  });
});
