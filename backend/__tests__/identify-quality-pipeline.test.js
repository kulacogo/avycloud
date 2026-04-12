'use strict';

const { runIdentifyQualityPipeline } = require('../lib/identify-quality-pipeline');

function makeProduct(overrides = {}) {
  return {
    id: 'test-product-1',
    identification: { name: 'Test Product Title', brand: 'TestBrand', category: 'Elektronik > Test', barcodes: [] },
    details: {
      categoryId: '12345',
      short_description: '<p>Test description.</p>',
      key_features: ['Feature 1 - benefit one'],
      attributes: { Farbe: 'Schwarz' },
      identifiers: { ean: '', gtin: '', upc: '', mpn: '' },
      images: [{ url_or_base64: 'https://storage.example.com/img1.jpg', source: 'upload', variant: 'reference' }],
      pricing: { lowest_price: { amount: 29.99, currency: 'EUR', sources: [{ url: 'https://idealo.de/test', name: 'idealo' }] } },
    },
    marketplace: { ebay: { title: 'Test Product Title' }, kaufland: { title: 'Test Kaufland' } },
    ops: {},
    notes: {},
    ...overrides,
  };
}

describe('identify-quality-pipeline', () => {
  describe('EAN validation', () => {
    it('keeps valid EAN-13 with correct checkdigit', async () => {
      const product = makeProduct();
      product.details.identifiers.ean = '4006381333931';
      const { product: result } = await runIdentifyQualityPipeline(product, {});
      expect(result.details.identifiers.ean).toBe('4006381333931');
    });

    it('discards EAN with invalid checkdigit', async () => {
      const product = makeProduct();
      product.details.identifiers.ean = '4006381333932';
      const { product: result } = await runIdentifyQualityPipeline(product, {});
      expect(result.details.identifiers.ean).toBe('');
    });

    it('discards non-numeric EAN', async () => {
      const product = makeProduct();
      product.details.identifiers.ean = 'ABCDEFGHIJKLM';
      const { product: result } = await runIdentifyQualityPipeline(product, {});
      expect(result.details.identifiers.ean).toBe('');
    });

    it('validates GTIN-14 separately', async () => {
      const product = makeProduct();
      product.details.identifiers.gtin = '00614141000037'; // invalid checkdigit
      const { product: result } = await runIdentifyQualityPipeline(product, {});
      expect(result.details.identifiers.gtin).toBe('');
    });

    it('filters invalid barcodes from identification.barcodes', async () => {
      const product = makeProduct();
      product.identification.barcodes = ['4006381333931', 'invalid123', '0000000000000'];
      const { product: result } = await runIdentifyQualityPipeline(product, {});
      expect(result.identification.barcodes).toContain('4006381333931');
      expect(result.identification.barcodes).not.toContain('invalid123');
    });

    it('reports validation counts in quality report', async () => {
      const product = makeProduct();
      product.details.identifiers.ean = '4006381333931';
      product.details.identifiers.gtin = 'bad';
      const { qualityReport } = await runIdentifyQualityPipeline(product, {});
      const step = qualityReport.steps.find(s => s.step === 'ean_validation');
      expect(step.ok).toBe(true);
      expect(step.validated).toBe(1);
      expect(step.discarded).toBe(1);
    });
  });

  describe('Web image integration', () => {
    it('maps web_image_urls from grounding to product images', async () => {
      const product = makeProduct();
      const grounded = { web_image_urls: ['https://shop.example.com/product-large.jpg', 'https://mfg.example.com/hero.png'] };
      const { product: result } = await runIdentifyQualityPipeline(product, grounded);
      const webImages = result.details.images.filter(i => i.source === 'grounding_web');
      expect(webImages).toHaveLength(2);
      expect(webImages[0].url_or_base64).toBe('https://shop.example.com/product-large.jpg');
    });

    it('skips duplicate URLs already in images', async () => {
      const product = makeProduct();
      product.details.images = [{ url_or_base64: 'https://shop.example.com/product-large.jpg', source: 'upload' }];
      const grounded = { web_image_urls: ['https://shop.example.com/product-large.jpg'] };
      const { product: result } = await runIdentifyQualityPipeline(product, grounded);
      expect(result.details.images).toHaveLength(1);
    });

    it('limits to 3 web images', async () => {
      const product = makeProduct();
      const grounded = { web_image_urls: ['https://a.com/1.jpg', 'https://b.com/2.jpg', 'https://c.com/3.jpg', 'https://d.com/4.jpg', 'https://e.com/5.jpg'] };
      const { product: result } = await runIdentifyQualityPipeline(product, grounded);
      const webImages = result.details.images.filter(i => i.source === 'grounding_web');
      expect(webImages).toHaveLength(3);
    });

    it('handles missing web_image_urls gracefully', async () => {
      const product = makeProduct();
      const { qualityReport } = await runIdentifyQualityPipeline(product, {});
      const step = qualityReport.steps.find(s => s.step === 'web_images');
      expect(step.ok).toBe(true);
      expect(step.added).toBe(0);
    });
  });

  describe('Mobile snippet', () => {
    it('stores mobile_snippet in marketplace.ebay', async () => {
      const product = makeProduct();
      const grounded = { mobile_snippet: 'Compact product summary for mobile' };
      const { product: result } = await runIdentifyQualityPipeline(product, grounded);
      expect(result.marketplace.ebay.mobile_snippet).toBe('Compact product summary for mobile');
    });

    it('truncates to 800 chars', async () => {
      const product = makeProduct();
      const grounded = { mobile_snippet: 'A'.repeat(1000) };
      const { product: result } = await runIdentifyQualityPipeline(product, grounded);
      expect(result.marketplace.ebay.mobile_snippet.length).toBe(800);
    });

    it('skips empty snippet', async () => {
      const product = makeProduct();
      const grounded = { mobile_snippet: '' };
      const { qualityReport } = await runIdentifyQualityPipeline(product, grounded);
      const step = qualityReport.steps.find(s => s.step === 'mobile_snippet');
      expect(step.applied).toBe(false);
    });
  });

  describe('Pipeline resilience', () => {
    it('does not throw with minimal product data', async () => {
      const product = { id: 'minimal', identification: {}, details: {}, ops: {}, notes: {} };
      await expect(runIdentifyQualityPipeline(product, {})).resolves.toBeDefined();
    });

    it('returns quality report with steps array', async () => {
      const product = makeProduct();
      const { qualityReport } = await runIdentifyQualityPipeline(product, {});
      expect(Array.isArray(qualityReport.steps)).toBe(true);
      expect(typeof qualityReport.totalIssues).toBe('number');
    });
  });
});
