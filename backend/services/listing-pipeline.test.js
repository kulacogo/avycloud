const {
  buildEbayListing,
  buildKauflandListing,
  validateEbayListing,
  validateKauflandListing,
  EBAY_TITLE_MAX,
  KAUFLAND_TITLE_MAX,
} = require('./listing-pipeline');

describe('listing-pipeline', () => {
  const baseProduct = {
    id: 'test-123',
    identification: {
      name: 'Apple iPhone 14 Pro 128GB Space Black',
      brand: 'Apple',
      category: 'Handys & Smartphones > Handys & Smartphones',
    },
    details: {
      short_description: 'Apple iPhone 14 Pro in Space Black mit 128GB Speicher.',
      categoryId: '9355',
      ebayCategoryPath: 'Handys & Kommunikation > Handys & Smartphones',
      kauflandCategoryId: '54321',
      kauflandCategoryPath: 'Smartphones',
      identifiers: {
        ean: ['1234567890123'],
        mpn: 'MPXE3ZD/A',
      },
      attributes: {
        condition: 'used_good',
        Modell: 'iPhone 14 Pro',
        Farbe: 'Space Black',
      },
      pricing: {
        sellPrice: 799,
      },
    },
  };

  // ─── buildEbayListing ──────────────────────────────────────────────────────

  describe('buildEbayListing', () => {
    it('should generate eBay listing from product data with Gemini result', () => {
      const gemini = {
        ebay: {
          title: 'Apple iPhone 14 Pro 128GB Space Black - Gebraucht Gut - OVP',
          description: '<p>Apple iPhone 14 Pro in Space Black mit 128GB.</p>',
        },
      };

      const listing = buildEbayListing(baseProduct, gemini);

      expect(listing.title).toBeTruthy();
      expect(listing.title.length).toBeLessThanOrEqual(EBAY_TITLE_MAX);
      expect(listing.description).toContain('Apple');
      expect(listing.categoryId).toBe('9355');
      expect(listing.attributes.Marke).toBe('Apple');
    });

    it('should fallback to product data when Gemini returns null', () => {
      const listing = buildEbayListing(baseProduct, null);

      expect(listing.title).toBeTruthy();
      expect(listing.description).toBeTruthy();
      expect(listing.categoryId).toBe('9355');
    });

    it('should truncate title exceeding max length', () => {
      const longTitle = 'A'.repeat(EBAY_TITLE_MAX + 20);
      const gemini = {
        ebay: { title: longTitle, description: 'Test description content for the listing.' },
      };

      const listing = buildEbayListing(baseProduct, gemini);

      expect(listing.title.length).toBeLessThanOrEqual(EBAY_TITLE_MAX);
    });
  });

  // ─── buildKauflandListing ──────────────────────────────────────────────────

  describe('buildKauflandListing', () => {
    it('should generate Kaufland listing from product data', () => {
      const gemini = {
        kaufland: {
          title: 'Apple iPhone 14 Pro 128GB Space Black Gebraucht Gut',
          description: 'Apple iPhone 14 Pro in Space Black mit 128GB Speicher. Zustand: Gebraucht - Gut.',
        },
      };

      const listing = buildKauflandListing(baseProduct, gemini);

      expect(listing.title).toBeTruthy();
      expect(listing.title.length).toBeLessThanOrEqual(KAUFLAND_TITLE_MAX);
      expect(listing.description).not.toContain('<');
      expect(listing.attributes.ean).toBe('1234567890123');
      expect(listing.attributes.brand).toBe('Apple');
    });

    it('should strip HTML from description', () => {
      const gemini = {
        kaufland: {
          title: 'Test Product Title for Kaufland',
          description: '<p>HTML content</p> with <strong>tags</strong>',
        },
      };

      const listing = buildKauflandListing(baseProduct, gemini);

      expect(listing.description).not.toContain('<');
      expect(listing.description).toContain('HTML content');
    });

    it('should fallback when Gemini returns null', () => {
      const listing = buildKauflandListing(baseProduct, null);

      expect(listing.title).toBeTruthy();
      expect(listing.attributes.ean).toBe('1234567890123');
    });
  });

  // ─── validateEbayListing ───────────────────────────────────────────────────

  describe('validateEbayListing', () => {
    it('should validate a complete eBay listing as ready', () => {
      const listing = {
        title: 'Apple iPhone 14 Pro 128GB Space Black',
        description: '<p>Apple iPhone 14 Pro in Space Black mit 128GB Speicher.</p>',
        categoryId: '9355',
        attributes: { Marke: 'Apple' },
      };

      const result = validateEbayListing(listing);

      expect(result.ready).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should flag missing title as error', () => {
      const listing = {
        title: '',
        description: '<p>Some description text here.</p>',
        categoryId: '9355',
      };

      const result = validateEbayListing(listing);

      expect(result.ready).toBe(false);
      expect(result.issues.some((i) => i.severity === 'error')).toBe(true);
    });

    it('should flag missing category as error', () => {
      const listing = {
        title: 'Valid Product Title Here',
        description: '<p>Description text content.</p>',
        categoryId: '',
      };

      const result = validateEbayListing(listing);

      expect(result.ready).toBe(false);
      expect(result.issues.some((i) => i.message.includes('Kategorie'))).toBe(true);
    });

    it('should flag too-long title as warning', () => {
      const listing = {
        title: 'X'.repeat(EBAY_TITLE_MAX + 5),
        description: '<p>Description text content here.</p>',
        categoryId: '9355',
      };

      const result = validateEbayListing(listing);

      expect(result.ready).toBe(true); // warning, not error
      expect(result.issues.some((i) => i.severity === 'warning' && i.message.includes('lang'))).toBe(true);
    });
  });

  // ─── validateKauflandListing ───────────────────────────────────────────────

  describe('validateKauflandListing', () => {
    it('should validate a complete Kaufland listing as ready', () => {
      const listing = {
        title: 'Apple iPhone 14 Pro 128GB',
        description: 'Apple iPhone 14 Pro in Space Black mit 128GB Speicher.',
        categoryId: '54321',
        attributes: { ean: '1234567890123', brand: 'Apple' },
      };

      const result = validateKauflandListing(listing);

      expect(result.ready).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('should flag missing EAN as error', () => {
      const listing = {
        title: 'Valid Product Title Here',
        description: 'Description text content for Kaufland listing.',
        categoryId: '54321',
        attributes: { brand: 'Apple' },
      };

      const result = validateKauflandListing(listing);

      expect(result.ready).toBe(false);
      expect(result.issues.some((i) => i.message.includes('EAN'))).toBe(true);
    });

    it('should flag missing title as error', () => {
      const listing = {
        title: '',
        description: 'Description text content here.',
        attributes: { ean: '1234567890123' },
      };

      const result = validateKauflandListing(listing);

      expect(result.ready).toBe(false);
      expect(result.issues.some((i) => i.severity === 'error')).toBe(true);
    });
  });
});
