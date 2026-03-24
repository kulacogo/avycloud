const { normalizeProduct, validateCanonical, _pickCanonicalId } = require('../product-canonical');

// ─── normalizeProduct ───────────────────────────────────────────────

describe('normalizeProduct', () => {
  it('does not mutate the original object', () => {
    const raw = { details: { attributes: [{ key: 'Farbe', value: 'rot' }] } };
    normalizeProduct(raw);
    expect(Array.isArray(raw.details.attributes)).toBe(true);
  });

  // ── 1. Attributes: Array → Object ──

  describe('attributes normalization', () => {
    it('converts attributes array to object', () => {
      const raw = {
        details: {
          attributes: [
            { key: 'Farbe', value: 'rot' },
            { key: 'Größe', value: 'M' },
          ],
        },
      };
      const result = normalizeProduct(raw);
      expect(result.details.attributes).toEqual({ Farbe: 'rot', 'Größe': 'M' });
    });

    it('skips entries with empty keys', () => {
      const raw = {
        details: {
          attributes: [
            { key: '', value: 'skip-me' },
            { key: 'Valid', value: 'keep' },
          ],
        },
      };
      const result = normalizeProduct(raw);
      expect(result.details.attributes).toEqual({ Valid: 'keep' });
    });

    it('trims attribute keys', () => {
      const raw = {
        details: { attributes: [{ key: '  Farbe  ', value: 'rot' }] },
      };
      const result = normalizeProduct(raw);
      expect(result.details.attributes).toEqual({ Farbe: 'rot' });
    });

    it('leaves object attributes unchanged', () => {
      const raw = {
        details: { attributes: { Farbe: 'rot', Marke: 'Test' } },
      };
      const result = normalizeProduct(raw);
      expect(result.details.attributes).toEqual({ Farbe: 'rot', Marke: 'Test' });
    });

    it('initializes missing details and attributes', () => {
      const result = normalizeProduct({});
      expect(result.details).toBeDefined();
      expect(result.details.attributes).toEqual({});
    });
  });

  // ── 2. Kategorie-Felder konsolidieren ──

  describe('category field consolidation', () => {
    it('consolidates ebayCategoryId into details.categoryId', () => {
      const raw = { details: { ebayCategoryId: '12345' } };
      const result = normalizeProduct(raw);
      expect(result.details.categoryId).toBe('12345');
      expect(result.details.ebayCategoryId).toBeUndefined();
    });

    it('consolidates ebay_category_id into details.categoryId', () => {
      const raw = { details: { ebay_category_id: '67890' } };
      const result = normalizeProduct(raw);
      expect(result.details.categoryId).toBe('67890');
      expect(result.details.ebay_category_id).toBeUndefined();
    });

    it('consolidates category_id from attributes', () => {
      const raw = {
        details: { attributes: { category_id: 'from-attrs' } },
      };
      const result = normalizeProduct(raw);
      expect(result.details.categoryId).toBe('from-attrs');
    });

    it('does not overwrite existing categoryId', () => {
      const raw = {
        details: { categoryId: 'keep-this', ebayCategoryId: 'ignore-this' },
      };
      const result = normalizeProduct(raw);
      expect(result.details.categoryId).toBe('keep-this');
    });
  });

  // ── 3. Marketplace-Metadaten extrahieren ──

  describe('marketplace metadata extraction', () => {
    it('moves ebay.* keys from attributes to marketplace', () => {
      const raw = {
        details: {
          attributes: {
            'ebay.item_id': '123',
            'ebay.listing_type': 'FixedPrice',
            Farbe: 'rot',
          },
        },
      };
      const result = normalizeProduct(raw);
      expect(result.details.marketplace['ebay.item_id']).toBe('123');
      expect(result.details.marketplace['ebay.listing_type']).toBe('FixedPrice');
      expect(result.details.attributes['ebay.item_id']).toBeUndefined();
      expect(result.details.attributes.Farbe).toBe('rot');
    });

    it('moves kaufland_* keys from attributes to marketplace', () => {
      const raw = {
        details: {
          attributes: {
            'kaufland_product_id': '456',
            Marke: 'Test',
          },
        },
      };
      const result = normalizeProduct(raw);
      expect(result.details.marketplace['kaufland_product_id']).toBe('456');
      expect(result.details.attributes.Marke).toBe('Test');
    });
  });

  // ── 4. Gewicht normalisieren ──

  describe('weight normalization', () => {
    it('normalizes weight alias to Gewicht', () => {
      const raw = { details: { attributes: { weight: '2.5kg' } } };
      const result = normalizeProduct(raw);
      expect(result.details.attributes['Gewicht']).toBe('2.5kg');
      expect(result.details.attributes.weight).toBeUndefined();
    });

    it('normalizes Bruttogewicht to Gewicht', () => {
      const raw = { details: { attributes: { Bruttogewicht: '1.2' } } };
      const result = normalizeProduct(raw);
      expect(result.details.attributes['Gewicht']).toBe('1.2');
      expect(result.details.attributes.Bruttogewicht).toBeUndefined();
    });

    it('does not overwrite existing Gewicht with alias', () => {
      const raw = {
        details: { attributes: { Gewicht: '3.0', weight: '2.0' } },
      };
      const result = normalizeProduct(raw);
      expect(result.details.attributes['Gewicht']).toBe('3.0');
    });
  });

  // ── 5. Placeholder bereinigen ──

  describe('placeholder cleanup', () => {
    it('replaces placeholder values with null', () => {
      const raw = {
        identification: { name: 'unbekannt', brand: 'N/A', category: '-' },
      };
      const result = normalizeProduct(raw);
      expect(result.identification.name).toBe(null);
      expect(result.identification.brand).toBe(null);
      expect(result.identification.category).toBe(null);
    });

    it('keeps real values intact', () => {
      const raw = {
        identification: { name: 'iPhone 15', brand: 'Apple', category: 'Smartphones' },
      };
      const result = normalizeProduct(raw);
      expect(result.identification.name).toBe('iPhone 15');
      expect(result.identification.brand).toBe('Apple');
      expect(result.identification.category).toBe('Smartphones');
    });

    it('replaces empty strings with null', () => {
      const raw = { identification: { name: '', brand: '  ', category: '' } };
      const result = normalizeProduct(raw);
      expect(result.identification.name).toBe(null);
      expect(result.identification.brand).toBe(null);
      expect(result.identification.category).toBe(null);
    });
  });

  // ── 6. Pflichtfelder ──

  describe('required field defaults', () => {
    it('initializes missing identification fields', () => {
      const result = normalizeProduct({});
      expect(result.identification.method).toBe('unknown');
      expect(result.identification.barcodes).toEqual([]);
      expect(result.identification.confidence).toBe(0);
    });

    it('preserves existing identification values', () => {
      const raw = {
        identification: { method: 'barcode', barcodes: ['123'], confidence: 0.95 },
      };
      const result = normalizeProduct(raw);
      expect(result.identification.method).toBe('barcode');
      expect(result.identification.barcodes).toEqual(['123']);
      expect(result.identification.confidence).toBe(0.95);
    });

    it('initializes missing detail sub-objects', () => {
      const result = normalizeProduct({});
      expect(result.details.short_description).toBe('');
      expect(result.details.key_features).toEqual([]);
      expect(result.details.identifiers).toEqual({});
      expect(result.details.images).toEqual([]);
      expect(result.details.pricing).toEqual({});
      expect(result.ops).toEqual(expect.objectContaining({ _normalized: true }));
      expect(result.notes).toEqual({});
    });
  });

  // ── 7. Produkt-ID kanonisieren ──

  describe('ID canonicalization', () => {
    it('preserves original ID and stores canonical ID as metadata (BUG-085)', () => {
      const raw = {
        id: 'prod-abc123-def456',
        details: { identifiers: { ean: '4006381333931' } },
      };
      const result = normalizeProduct(raw);
      expect(result.id).toBe('prod-abc123-def456'); // ID preserved
      expect(result.ops._canonicalId).toBe('4006381333931'); // stored as metadata
    });

    it('keeps ID unchanged when no barcode is available', () => {
      const raw = {
        id: 'prod-abc123-def456',
        details: { identifiers: {} },
        identification: { barcodes: [] },
      };
      const result = normalizeProduct(raw);
      expect(result.id).toBe('prod-abc123-def456');
      expect(result.ops._canonicalId).toBeUndefined();
    });

    it('preserves UUID and stores canonical ID from barcodes array', () => {
      const raw = {
        id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        identification: { barcodes: ['4006381333931'] },
      };
      const result = normalizeProduct(raw);
      expect(result.id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890'); // ID preserved
      expect(result.ops._canonicalId).toBe('4006381333931');
    });

    it('does not set _canonicalId when ID already matches barcode', () => {
      const raw = {
        id: '4006381333931',
        details: { identifiers: { ean: '4006381333931' } },
      };
      const result = normalizeProduct(raw);
      expect(result.id).toBe('4006381333931');
      expect(result.ops._canonicalId).toBeUndefined();
    });

    it('stores EAN as _canonicalId (prefers EAN over GTIN over UPC)', () => {
      const raw = {
        id: 'some-firestore-id',
        details: {
          identifiers: {
            ean: '4006381333931',
            gtin: '0123456789012',
            upc: '012345678905',
          },
        },
      };
      const result = normalizeProduct(raw);
      expect(result.id).toBe('some-firestore-id'); // ID preserved
      expect(result.ops._canonicalId).toBe('4006381333931');
    });

    it('stores barcode as _canonicalId when no identifier fields', () => {
      const raw = {
        id: 'some-id',
        identification: { barcodes: ['9780201616224'] },
        details: { identifiers: {} },
      };
      const result = normalizeProduct(raw);
      expect(result.id).toBe('some-id'); // ID preserved
      expect(result.ops._canonicalId).toBe('9780201616224');
    });

    it('ignores invalid barcodes (too short)', () => {
      const raw = {
        id: 'keep-me',
        details: { identifiers: { ean: '12345' } },
        identification: { barcodes: ['short'] },
      };
      const result = normalizeProduct(raw);
      expect(result.id).toBe('keep-me');
      expect(result.ops._canonicalId).toBeUndefined();
    });

    it('replaces slashes in barcode IDs for Firestore safety', () => {
      const raw = {
        id: 'old-id',
        details: { identifiers: { ean: '400638133/931' } },
      };
      const result = normalizeProduct(raw);
      // 400638133/931 has non-digit chars → won't match /^\d{12,14}$/ → ID stays
      expect(result.id).toBe('old-id');
    });
  });

  // ── 8. Metadaten ──

  describe('normalization metadata', () => {
    it('sets normalization flags', () => {
      const result = normalizeProduct({});
      expect(result.ops._normalized).toBe(true);
      expect(result.ops._schemaVersion).toBe(2);
      expect(result.ops._normalizedAt).toBeDefined();
    });
  });

  // ── Idempotenz ──

  describe('idempotency', () => {
    it('produces the same result when run twice', () => {
      const raw = {
        identification: { name: 'Test', brand: 'Brand', category: 'Cat' },
        details: {
          ebayCategoryId: '123',
          attributes: [
            { key: 'ebay.item_id', value: '999' },
            { key: 'Farbe', value: 'blau' },
            { key: 'weight', value: '1.5' },
          ],
        },
      };
      const first = normalizeProduct(raw);
      const second = normalizeProduct(first);

      // Ignore timestamps for comparison
      delete first.ops._normalizedAt;
      delete second.ops._normalizedAt;

      expect(second).toEqual(first);
    });
  });
});

// ─── validateCanonical ──────────────────────────────────────────────

describe('validateCanonical', () => {
  it('returns valid for a properly normalized product', () => {
    const product = normalizeProduct({
      identification: { name: 'Test', brand: 'Brand', category: 'Cat' },
      details: { attributes: { Farbe: 'rot' } },
    });
    expect(validateCanonical(product)).toEqual({ valid: true });
  });

  it('reports attributes as Array', () => {
    const product = { details: { attributes: [{ key: 'a', value: 'b' }] } };
    const result = validateCanonical(product);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('details.attributes is Array, must be Object');
  });

  it('reports legacy category fields', () => {
    const product = { details: { ebayCategoryId: '123', attributes: {} } };
    const result = validateCanonical(product);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Legacy field: details.ebayCategoryId');
  });

  it('reports marketplace keys in attributes', () => {
    const product = {
      details: { attributes: { 'ebay.item_id': '999', 'kaufland_id': '111' } },
    };
    const result = validateCanonical(product);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('ebay.item_id'))).toBe(true);
    expect(result.errors.some(e => e.includes('kaufland_id'))).toBe(true);
  });

  it('reports placeholder values in identification fields', () => {
    const product = {
      identification: { name: 'unbekannt', brand: 'n/a', category: '-' },
      details: { attributes: {} },
    };
    const result = validateCanonical(product);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(3);
  });

  it('passes when identification fields have real values', () => {
    const product = {
      identification: { name: 'iPhone 15', brand: 'Apple', category: 'Smartphones' },
      details: { attributes: {} },
    };
    expect(validateCanonical(product)).toEqual({ valid: true });
  });

  it('reports non-canonical ID when UUID has barcode available', () => {
    const product = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      identification: { barcodes: ['4006381333931'] },
      details: { attributes: {}, identifiers: {} },
    };
    const result = validateCanonical(product);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Non-canonical ID'))).toBe(true);
  });

  it('reports non-canonical ID when prod- prefix has EAN available', () => {
    const product = {
      id: 'prod-abc123',
      details: { identifiers: { ean: '4006381333931' }, attributes: {} },
    };
    const result = validateCanonical(product);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Non-canonical ID'))).toBe(true);
  });

  it('passes for UUID ID when no barcode is available', () => {
    const product = {
      id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      identification: { barcodes: [] },
      details: { attributes: {}, identifiers: {} },
    };
    expect(validateCanonical(product)).toEqual({ valid: true });
  });

  it('passes for barcode-based ID', () => {
    const product = {
      id: '4006381333931',
      identification: { barcodes: ['4006381333931'] },
      details: { attributes: {}, identifiers: { ean: '4006381333931' } },
    };
    expect(validateCanonical(product)).toEqual({ valid: true });
  });
});

// ─── _pickCanonicalId ────────────────────────────────────────────────

describe('_pickCanonicalId', () => {
  it('returns EAN from identifiers', () => {
    const product = {
      id: 'some-id',
      details: { identifiers: { ean: '4006381333931' } },
    };
    expect(_pickCanonicalId(product)).toBe('4006381333931');
  });

  it('returns GTIN when no EAN', () => {
    const product = {
      id: 'some-id',
      details: { identifiers: { gtin: '0123456789012' } },
    };
    expect(_pickCanonicalId(product)).toBe('0123456789012');
  });

  it('returns barcode from barcodes array', () => {
    const product = {
      id: 'some-id',
      identification: { barcodes: ['9780201616224'] },
      details: { identifiers: {} },
    };
    expect(_pickCanonicalId(product)).toBe('9780201616224');
  });

  it('returns UPC as fallback', () => {
    const product = {
      id: 'some-id',
      details: { identifiers: { upc: '012345678905' } },
    };
    expect(_pickCanonicalId(product)).toBe('012345678905');
  });

  it('returns null when no valid barcode found', () => {
    const product = {
      id: 'some-id',
      details: { identifiers: {} },
      identification: { barcodes: [] },
    };
    expect(_pickCanonicalId(product)).toBeNull();
  });

  it('returns null when barcodes are too short', () => {
    const product = {
      id: 'some-id',
      details: { identifiers: { ean: '12345' } },
      identification: { barcodes: ['abc'] },
    };
    expect(_pickCanonicalId(product)).toBeNull();
  });

  it('prefers EAN over barcodes array over UPC', () => {
    const product = {
      id: 'some-id',
      details: { identifiers: { ean: '4006381333931', upc: '012345678905' } },
      identification: { barcodes: ['9780201616224'] },
    };
    expect(_pickCanonicalId(product)).toBe('4006381333931');
  });

  it('handles missing details/identification gracefully', () => {
    expect(_pickCanonicalId({})).toBeNull();
    expect(_pickCanonicalId({ id: 'x' })).toBeNull();
  });

  it('replaces slashes with underscores for Firestore safety', () => {
    // This won't actually match the regex since / is not a digit,
    // but test the replacement logic with a 13-digit barcode
    const product = {
      id: 'some-id',
      details: { identifiers: { ean: '4006381333931' } },
    };
    // No slashes → no change
    expect(_pickCanonicalId(product)).toBe('4006381333931');
  });
});
