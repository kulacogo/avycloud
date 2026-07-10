// backend/__tests__/shipping-packstation.test.js
//
// Regression for SendCloud 400 "Die Postnummer des Empfängers fehlt oder ist
// ungültig" (receiver_address) on DHL Packstation orders — incident
// 13-14686-13071 ("DHL Packstation 142, 19053 Schwerin").
//
// Verifies createParcel():
//   1. throws a clear, actionable error (not an opaque SendCloud 400) when a
//      Packstation order has no Postnummer — and never calls SendCloud.
//   2. sends to_post_number + "PACKSTATION <n>" address when the operator
//      supplied an explicit customer.postNumber.
//   3. recovers a Postnummer embedded AFTER the station token in the street.

require('./api/_patchGcp');

// Stub SendCloud credential + CSV lookup so requiring the engine is side-effect free.
const secretValuesPath = require.resolve('../lib/secret-values');
require.cache[secretValuesPath] = {
  id: secretValuesPath, filename: secretValuesPath, loaded: true,
  exports: { getSecretValue: vi.fn().mockResolvedValue('mock-secret') },
  children: [], paths: [],
};
const sendcloudPath = require.resolve('../lib/sendcloud');
require.cache[sendcloudPath] = {
  id: sendcloudPath, filename: sendcloudPath, loaded: true,
  exports: {
    lookupCsvPrice: vi.fn().mockResolvedValue(null),
    listSenderAddresses: vi.fn().mockResolvedValue([
      { id: 1, companyName: 'TrendOcean', street: 'Musterstr 1', city: 'Berlin', postalCode: '10115', country: 'DE' },
    ]),
  },
  children: [], paths: [],
};

const { createParcel } = require('../services/shipping-engine');

function baseOrder(customer) {
  return {
    id: 'order-1',
    marketplaceOrderId: '13-14686-13071',
    marketplace: 'ebay',
    customer,
    items: [{ quantity: 1, weight: 1.25 }],
  };
}

// URL-aware SendCloud v3 mock: shipping-options (POST /shipping-options) then
// create+announce (POST /shipments/announce). createParcel reads res.text().
function v3FetchMock() {
  const option = {
    code: 'dhl:parcel',
    carrier: { code: 'dhl', name: 'DHL' },
    product: { code: 'parcel', name: 'DHL Paket' },
    weight: { min: { value: '0.01' }, max: { value: '31.5' } },
    quotes: [{ price: { total: { value: '5.49' } } }],
  };
  const shipment = {
    id: 'shp_1',
    carrier: { code: 'dhl' },
    parcels: [{
      id: 123,
      tracking_number: 'TRACK123',
      tracking_url: 'https://track/TRACK123',
      status: { code: 'announced', message: 'ready to send' },
      documents: [{ type: 'label', size: 'a6', link: 'https://sendcloud/label.pdf' }],
    }],
  };
  return vi.fn((url) => {
    const body = String(url).includes('/shipping-options') ? { data: [option] } : { data: shipment };
    return Promise.resolve({ ok: true, text: async () => JSON.stringify(body), json: async () => body });
  });
}

describe('createParcel — DHL Packstation Postnummer', () => {
  afterEach(() => {
    if (global.fetch && global.fetch.mockRestore) global.fetch.mockRestore();
    vi.restoreAllMocks();
  });

  it('throws an actionable error and never calls SendCloud when Postnummer is missing', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    const order = baseOrder({
      name: 'Andreas Natusch',
      street: 'DHL Packstation 142',
      city: 'Schwerin',
      zip: '19053',
      country: 'DE',
    });

    await expect(createParcel({ order, weight: 1.25, requestLabel: false }))
      .rejects.toThrow(/Postnummer fehlt/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends po_box (Postnummer) + PACKSTATION address (v3) when an explicit postNumber is set', async () => {
    const fetchSpy = v3FetchMock();
    global.fetch = fetchSpy;

    const order = baseOrder({
      name: 'Andreas Natusch',
      street: 'DHL Packstation 142',
      city: 'Schwerin',
      zip: '19053',
      country: 'DE',
      postNumber: '1234567',
    });

    await createParcel({ order, weight: 1.25, requestLabel: false });

    const announce = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/shipments/announce'));
    const body = JSON.parse(announce[1].body);
    expect(body.to_address.po_box).toBe('1234567');
    expect(body.to_address.address_line_1).toBe('PACKSTATION 142');
    expect(body.to_address.house_number).toBe('142');
  });

  it('recovers a Postnummer embedded after the station token in the street (v3)', async () => {
    const fetchSpy = v3FetchMock();
    global.fetch = fetchSpy;

    const order = baseOrder({
      name: 'Andreas Natusch',
      street: 'Packstation 142, 12345678',
      city: 'Schwerin',
      zip: '19053',
      country: 'DE',
    });

    await createParcel({ order, weight: 1.25, requestLabel: false });

    const announce = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/shipments/announce'));
    const body = JSON.parse(announce[1].body);
    expect(body.to_address.po_box).toBe('12345678');
    expect(body.to_address.address_line_1).toBe('PACKSTATION 142');
  });
});
