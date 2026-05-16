'use strict';

/**
 * Service-level tests for services/kaufland-product-data-repair.js
 * (extracted from admin-bulk-actions.js).
 *
 * Pure functions (buildKauflandComplianceContact,
 * buildKauflandProductDataAttributes, capKauflandAttributes) are tested
 * directly without any Firestore/Kaufland-API mocking. The IO-using
 * tryRepairKauflandProductData is tested with require.cache patching of
 * lib/kaufland-api (Vitest 4.x CJS-friendly pattern).
 */

// vitest globals: true — describe/it/expect/vi are global.

function installModuleMock(modulePath, mockExports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: mockExports,
    children: [],
    paths: [],
  };
  return resolved;
}

// ─── Mock kaufland-api so IO calls in tryRepair return predictable shapes ─
const getProductDataMock = vi.fn();
const getProductDataStatusMock = vi.fn();
const putProductDataMock = vi.fn();
const patchProductDataMock = vi.fn();

installModuleMock('../../lib/kaufland-api', {
  getProductData: getProductDataMock,
  getProductDataStatus: getProductDataStatusMock,
  putProductData: putProductDataMock,
  patchProductData: patchProductDataMock,
});

// ─── SUT ──────────────────────────────────────────────────────────────────
const repair = require('../../services/kaufland-product-data-repair');

beforeEach(() => {
  getProductDataMock.mockReset();
  getProductDataStatusMock.mockReset();
  putProductDataMock.mockReset();
  patchProductDataMock.mockReset();
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe('buildKauflandComplianceContact', () => {
  it('returns a contact block when name + address are derivable from gpsr', () => {
    const out = repair.buildKauflandComplianceContact(
      {
        details: {
          gpsr: {
            manufacturer_name: 'ACME GmbH',
            manufacturer_address: 'Hauptstr. 1',
            manufacturer_city: 'Berlin',
            manufacturer_postalcode: '10115',
            country_code: 'DE',
            email: 'info@acme.de',
            url: 'https://acme.de',
            manufacturer_phone: '+49 30 1234',
          },
        },
      },
      'fallback brand'
    );
    expect(out).toEqual({
      name: 'ACME GmbH',
      address: 'Hauptstr. 1, Berlin, 10115, DE',
      email_address: 'info@acme.de',
      url: 'https://acme.de',
      phone_number: '+49 30 1234',
    });
  });

  it('falls back to the brand for the name when manufacturer_name is empty', () => {
    const out = repair.buildKauflandComplianceContact(
      {
        details: {
          gpsr: {
            manufacturer_address: 'Hauptstr. 1',
            manufacturer_city: 'Berlin',
            manufacturer_postalcode: '10115',
            country_code: 'DE',
          },
        },
      },
      'BrandX'
    );
    expect(out).not.toBeNull();
    expect(out.name).toBe('BrandX');
    expect(out.address).toBe('Hauptstr. 1, Berlin, 10115, DE');
  });

  it('returns null when neither name nor address can be derived', () => {
    expect(repair.buildKauflandComplianceContact({}, '')).toBeNull();
    expect(
      repair.buildKauflandComplianceContact(
        { details: { gpsr: { manufacturer_name: 'X' } } },
        ''
      )
    ).toBeNull(); // address missing
  });
});

describe('buildKauflandProductDataAttributes', () => {
  it('builds the base attributes (title, description, picture, manufacturer) from identification + details', () => {
    const attrs = repair.buildKauflandProductDataAttributes({
      identification: { name: 'Test Title', brand: 'BrandY' },
      details: {
        short_description: '<p>Hello <b>world</b></p>',
        images: [
          'https://cdn/example/img1.jpg',
          { url: 'https://cdn/example/img2.jpg' },
          'not-a-url',
        ],
      },
    });
    expect(attrs.title).toEqual(['Test Title']);
    expect(attrs.description).toEqual(['Hello world']);
    expect(attrs.picture).toEqual([
      'https://cdn/example/img1.jpg',
      'https://cdn/example/img2.jpg',
    ]);
    expect(attrs.manufacturer).toEqual(['BrandY']);
  });

  it('emits product_safety_contact when gpsr data is complete', () => {
    const attrs = repair.buildKauflandProductDataAttributes({
      identification: { name: 'X', brand: 'BrandZ' },
      details: {
        gpsr: {
          manufacturer_name: 'ACME GmbH',
          manufacturer_address: 'Hauptstr. 1',
          manufacturer_city: 'Berlin',
          manufacturer_postalcode: '10115',
          country_code: 'DE',
        },
      },
    });
    expect(attrs.product_safety_contact).toEqual({
      name: 'ACME GmbH',
      address: 'Hauptstr. 1, Berlin, 10115, DE',
    });
  });

  it('honours missingAttributes by pulling values from details.attributes', () => {
    const attrs = repair.buildKauflandProductDataAttributes(
      {
        identification: { name: 'X', brand: 'BrandY' },
        details: {
          attributes: { color: 'red', size: 'XL' },
        },
      },
      { missingAttributes: ['color'] }
    );
    expect(attrs.color).toEqual(['red']);
  });
});

describe('capKauflandAttributes', () => {
  it('trims to the maxCap and returns the kept attributes as a record', () => {
    const input = {};
    for (let i = 0; i < 50; i++) input[`attr_${i}`] = `value_${i}`;
    const { trimmed, removed, meta } = repair.capKauflandAttributes(input, 45);
    expect(Object.keys(trimmed).length).toBe(45);
    expect(removed.length).toBe(5);
    expect(meta.cap).toBe(45);
  });

  it('is a no-op when input is already under the cap', () => {
    const input = { a: '1', b: '2' };
    const { trimmed, removed, meta } = repair.capKauflandAttributes(input, 45);
    expect(Object.keys(trimmed).sort()).toEqual(['a', 'b']);
    expect(removed.length).toBe(0);
    expect(meta.outputCount).toBe(2);
  });
});

describe('tryRepairKauflandProductData', () => {
  it('skips when EAN is missing or non-numeric', async () => {
    const out = await repair.tryRepairKauflandProductData({ product: {}, ean: '' });
    expect(out.attempted).toBe(false);
    expect(out.message).toMatch(/EAN/);
    expect(patchProductDataMock).not.toHaveBeenCalled();
  });

  it('skips when no attributes can be derived from the product', async () => {
    getProductDataStatusMock.mockResolvedValue({
      product_ready: false,
      missing_attributes: [],
      min_one_missing_attributes: [],
    });
    getProductDataMock.mockResolvedValue(null);

    const out = await repair.tryRepairKauflandProductData({
      product: {}, // no title/desc/images/brand → nothing to send
      ean: '4012345678901',
    });
    expect(out.attempted).toBe(false);
    expect(out.patchedKeys).toEqual([]);
    expect(patchProductDataMock).not.toHaveBeenCalled();
    expect(putProductDataMock).not.toHaveBeenCalled();
  });

  it('PATCHes attributes and reports success when storedProductData is returned afterwards', async () => {
    getProductDataStatusMock
      .mockResolvedValueOnce({
        product_ready: false,
        missing_attributes: [],
        min_one_missing_attributes: [],
      })
      .mockResolvedValueOnce({
        product_ready: true,
        update_status: 'success',
      });
    getProductDataMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ attributes: { title: ['Test'] } });

    patchProductDataMock.mockResolvedValue({});

    const out = await repair.tryRepairKauflandProductData({
      product: {
        identification: { name: 'Test', brand: 'BrandY' },
        details: {},
      },
      ean: '4012345678901',
    });

    expect(out.attempted).toBe(true);
    expect(out.patchedKeys).toEqual(expect.arrayContaining(['title', 'manufacturer']));
    expect(patchProductDataMock).toHaveBeenCalledTimes(1);
    expect(putProductDataMock).not.toHaveBeenCalled();
    expect(out.message).toMatch(/Product-Data via patch/);
  });
});
