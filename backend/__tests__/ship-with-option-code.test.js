'use strict';
// createParcel/shipOrder mit exaktem shippingOptionCode überspringt den
// Fuzzy-Resolver UND den /shipping-options-Call und kündigt genau den Code an.
require('./api/_patchGcp');

const authPath = require.resolve('../lib/sendcloud-auth');
require.cache[authPath] = {
  id: authPath, filename: authPath, loaded: true,
  exports: { getSendCloudAuthHeader: vi.fn().mockResolvedValue('Basic test') },
  children: [], paths: [],
};

const sendcloudPath = require.resolve('../lib/sendcloud');
require.cache[sendcloudPath] = {
  id: sendcloudPath, filename: sendcloudPath, loaded: true,
  exports: {
    lookupCsvPrice: vi.fn().mockResolvedValue(null),
    listSenderAddresses: vi.fn().mockResolvedValue([
      { companyName: 'TrendOcean', street: 'Absenderstr 1', city: 'Berlin', postalCode: '10115', country: 'DE' },
    ]),
  },
  children: [], paths: [],
};

const secretValuesPath = require.resolve('../lib/secret-values');
require.cache[secretValuesPath] = {
  id: secretValuesPath, filename: secretValuesPath, loaded: true,
  exports: { getSecretValue: vi.fn().mockResolvedValue('mock-secret') },
  children: [], paths: [],
};

const { createParcel } = require('../services/shipping-engine');

const order = {
  id: 'o1', marketplaceOrderId: 'MP1',
  customer: { name: 'Max Mustermann', street: 'Kundenstr 5', city: 'Hamburg', zip: '20095', country: 'DE' },
};

describe('createParcel mit shippingOptionCode', () => {
  let fetchCalls;
  beforeEach(() => {
    fetchCalls = [];
  });

  it('kündigt den exakten Code an, OHNE /shipping-options aufzurufen', async () => {
    global.fetch = vi.fn(async (url, opts) => {
      const u = String(url);
      fetchCalls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
      if (u.includes('/shipments/announce')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'ship1', parcels: [{ id: 42, tracking_number: 'TRACK123', tracking_url: 'http://t', documents: [{ type: 'label', link: 'http://label' }] }] } }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) };
    });

    const res = await createParcel({ order, shippingOptionCode: 'dhl_de:dhl_paket', weight: 2, tenantId: 'default' });
    expect(res.trackingNumber).toBe('TRACK123');
    expect(fetchCalls.some((c) => c.url.includes('/shipping-options'))).toBe(false);
    const announce = fetchCalls.find((c) => c.url.includes('/shipments/announce'));
    expect(announce).toBeTruthy();
    expect(announce.body.ship_with.properties.shipping_option_code).toBe('dhl_de:dhl_paket');
  });

  it('ohne Code: Alt-Pfad listet Optionen und matcht selbst', async () => {
    global.fetch = vi.fn(async (url, opts) => {
      const u = String(url);
      fetchCalls.push({ url: u, body: opts?.body ? JSON.parse(opts.body) : null });
      if (u.includes('/shipping-options')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ code: 'dhl_de:dhl_paket', carrier: { code: 'dhl_de' }, product: { name: 'DHL Paket' }, weight: { min: { value: 0 }, max: { value: 31.5 } } }] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: { id: 'ship1', parcels: [{ id: 42, tracking_number: 'TRACK999', documents: [{ type: 'label', link: 'http://label' }] }] } }) };
    });

    const res = await createParcel({ order, shippingMethodId: 89, weight: 2, tenantId: 'default' });
    expect(fetchCalls.some((c) => c.url.includes('/shipping-options'))).toBe(true);
    expect(res.trackingNumber).toBe('TRACK999');
  });
});
