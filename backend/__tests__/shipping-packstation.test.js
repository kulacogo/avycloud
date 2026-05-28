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
  exports: { lookupCsvPrice: vi.fn().mockResolvedValue(null) },
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

// A minimal "label created" SendCloud response so the happy path resolves.
function okParcelResponse() {
  return {
    ok: true,
    json: async () => ({
      parcel: {
        id: 123,
        status: { id: 1000, message: 'ready to send' },
        label: { label_printer: 'https://sendcloud/label.pdf' },
        tracking_number: 'TRACK123',
        tracking_url: 'https://track/TRACK123',
        carrier: { code: 'dhl' },
      },
    }),
  };
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

  it('sends to_post_number + PACKSTATION address when an explicit postNumber is set', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okParcelResponse());
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

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.parcel.to_post_number).toBe('1234567');
    expect(body.parcel.address).toBe('PACKSTATION 142');
    expect(body.parcel.house_number).toBe('142');
  });

  it('recovers a Postnummer embedded after the station token in the street', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(okParcelResponse());
    global.fetch = fetchSpy;

    const order = baseOrder({
      name: 'Andreas Natusch',
      street: 'Packstation 142, 12345678',
      city: 'Schwerin',
      zip: '19053',
      country: 'DE',
    });

    await createParcel({ order, weight: 1.25, requestLabel: false });

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.parcel.to_post_number).toBe('12345678');
    expect(body.parcel.address).toBe('PACKSTATION 142');
  });
});
