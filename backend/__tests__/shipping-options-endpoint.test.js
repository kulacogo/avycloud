'use strict';
// listCuratedShippingOptions holt LIVE-v3-Optionen (fetch gepatcht) und mappt
// sie über den kuratierten Katalog. Testet die Service-Schicht (nicht HTTP —
// der Endpoint selbst braucht Firestore und wird manuell abgenommen).
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

const engine = require('../services/shipping-engine');

describe('listCuratedShippingOptions', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async (url, opts) => {
      const u = String(url);
      if (u.includes('/shipping-options')) {
        const body = opts?.body ? JSON.parse(opts.body) : {};
        const to = body?.to_address?.country_code;
        const data = to === 'FR'
          ? [
              { code: 'dhl_de:warenpostinternational', weight: { min: { value: 0 }, max: { value: 1 } } },
              { code: 'dhl_de:warenpostinternational/premium', weight: { min: { value: 0 }, max: { value: 1 } } },
              { code: 'dpd:classic', weight: { min: { value: 0 }, max: { value: 5 } } },
              { code: 'dhl_de:weltpaket', weight: { min: { value: 0 }, max: { value: 31.5 } } },
            ]
          : [
              { code: 'dp:maxibrief/mailbox', weight: { min: { value: 0 }, max: { value: 1 } } },
              { code: 'dhl_de:dhl_paket', weight: { min: { value: 0 }, max: { value: 31.5 } } },
              { code: 'dpd:classic', weight: { min: { value: 0 }, max: { value: 5 } } },
            ];
        return { ok: true, status: 200, text: async () => JSON.stringify({ data }) };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    });
  });

  it('DE liefert nationale Produkte (nach Gewicht gefiltert)', async () => {
    const order = { id: 'o', customer: { country: 'DE', zip: '10115', city: 'B', street: 'S 1', name: 'N' } };
    const r = await engine.listCuratedShippingOptions({ order, weightKg: 2 });
    expect(r.scope).toBe('national');
    expect(r.warn).toBe(false);
    expect(r.products.map((p) => p.key)).toEqual(['dpd_classic', 'dhl_paket']);
  });

  it('FR liefert internationale Produkte inkl. DPD Europa; Warenpost Int NUR als Premium', async () => {
    const order = { id: 'o', totalAmount: 25, customer: { country: 'FR', zip: '75001', city: 'Paris', street: 'R 1', name: 'N' } };
    const r = await engine.listCuratedShippingOptions({ order, weightKg: 0.8 });
    expect(r.scope).toBe('international');
    expect(r.products.map((p) => p.key)).toContain('dpd_classic_europa');
    expect(r.products.find((p) => p.key === 'warenpost_int').shippingOptionCode).toBe('dhl_de:warenpostinternational/premium');
  });

  // Tracking-Pflicht ab 10 €: der Bestellwert kommt aus dem Order-Doc (totalAmount).
  it('Bestellwert unter 10 €: Maxibrief bleibt in der Auswahl', async () => {
    const order = { id: 'o', totalAmount: 6.5, customer: { country: 'DE', zip: '10115', city: 'B', street: 'S 1', name: 'N' } };
    const r = await engine.listCuratedShippingOptions({ order, weightKg: 0.4 });
    expect(r.trackedOnly).toBe(false);
    expect(r.products.map((p) => p.key)).toContain('maxibrief');
  });

  it('Bestellwert ab 10 €: Maxibrief fliegt raus, trackedOnly=true', async () => {
    const order = { id: 'o', totalAmount: 25, customer: { country: 'DE', zip: '10115', city: 'B', street: 'S 1', name: 'N' } };
    const r = await engine.listCuratedShippingOptions({ order, weightKg: 0.4 });
    expect(r.trackedOnly).toBe(true);
    expect(r.products.map((p) => p.key)).not.toContain('maxibrief');
  });

  it('ohne Betragsdaten am Auftrag: fail-safe Richtung Tracking', async () => {
    const order = { id: 'o', customer: { country: 'DE', zip: '10115', city: 'B', street: 'S 1', name: 'N' } };
    const r = await engine.listCuratedShippingOptions({ order, weightKg: 0.4 });
    expect(r.trackedOnly).toBe(true);
    expect(r.products.map((p) => p.key)).not.toContain('maxibrief');
  });
});
