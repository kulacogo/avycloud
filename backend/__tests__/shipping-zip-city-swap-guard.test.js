'use strict';
// Regression: Auftrag 07-14991-66886 (2026-08-04, BE). eBay lieferte
// PostalCode="Antwerpen" / CityName="2000" (Felder beim Käufer vertauscht,
// eBay validiert das nicht). createParcel schickte das 1:1 an SendCloud und der
// Operator bekam nur die rohe API-Meldung zu sehen:
//   SendCloud create parcel 400: ... "Enter a valid zip code." pointer=postal_code
// → 8 Fehlversuche in 6 Minuten, ohne Hinweis worauf.
//
// createParcel muss VOR dem SendCloud-Call fail-fast abbrechen und dem
// Menschen genau sagen, was zu tun ist — inklusive der korrigierten Werte.
// Bewusst KEINE stille Auto-Korrektur im Label-Pfad: Rechnung, Lieferschein
// und Adresslabel lesen dieselbe Adresse; ein nur fürs Label gedrehter Wert
// würde die Dokumente auseinanderlaufen lassen.
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
      { companyName: 'TrendOcean', street: 'Gahmener Str. 185', city: 'Lünen', postalCode: '44532', country: 'DE' },
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

function orderWith(customer) {
  return { id: 'o1', marketplaceOrderId: '07-14991-66886', customer };
}

describe('createParcel — PLZ/Stadt-Vertauschung', () => {
  let fetchCalls;
  beforeEach(() => {
    fetchCalls = [];
    global.fetch = vi.fn(async (url) => {
      fetchCalls.push(String(url));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: { parcels: [{ id: 1, documents: [] }] } }),
      };
    });
  });

  it('bricht ab, BEVOR SendCloud gerufen wird — mit den korrigierten Werten im Klartext', async () => {
    const order = orderWith({
      name: 'Buseyne Eric',
      street: 'Generaal Belliardstraat 9',
      city: '2000',
      zip: 'Antwerpen',
      country: 'BE',
    });

    await expect(
      createParcel({ order, shippingOptionCode: 'dhl_de:warenpostinternational', weight: 0.1 })
    ).rejects.toThrow(/vertauscht/i);

    // Kein einziger SendCloud-Call — der Fehler kostet kein API-Kontingent.
    expect(fetchCalls).toEqual([]);
  });

  it('nennt die konkreten Zielwerte, damit der Operator nicht raten muss', async () => {
    const order = orderWith({
      name: 'Buseyne Eric', street: 'Generaal Belliardstraat 9',
      city: '2000', zip: 'Antwerpen', country: 'BE',
    });
    const err = await createParcel({ order, shippingOptionCode: 'dhl_de:warenpostinternational', weight: 0.1 })
      .then(() => null, (e) => e);

    expect(err).toBeTruthy();
    expect(err.message).toContain('2000');
    expect(err.message).toContain('Antwerpen');
  });

  it('meldet eine ungültige PLZ auch ohne erkennbaren Tausch', async () => {
    const order = orderWith({
      name: 'Test', street: 'Teststr 1', city: 'Antwerpen', zip: 'ABC', country: 'BE',
    });

    await expect(
      createParcel({ order, shippingOptionCode: 'dhl_de:warenpostinternational', weight: 0.1 })
    ).rejects.toThrow(/keine gültige Postleitzahl/i);
    expect(fetchCalls).toEqual([]);
  });

  it('lässt eine gültige NL-Adresse durch (9645CW/Veendam darf NIE blockiert werden)', async () => {
    const order = orderWith({
      name: 'Jan', street: 'Kerkstraat 12', city: 'Veendam', zip: '9645CW', country: 'NL',
    });

    await createParcel({ order, shippingOptionCode: 'dhl_de:europaket', weight: 1 });
    expect(fetchCalls.some((u) => /shipments\/announce/.test(u))).toBe(true);
  });

  it('lässt Länder ohne hinterlegtes PLZ-Muster unangetastet durch (fail-open)', async () => {
    const order = orderWith({
      name: 'Sean', street: 'Main St 4', city: 'Dublin', zip: 'D02 AF30', country: 'IE',
    });

    await createParcel({ order, shippingOptionCode: 'dhl_de:europaket', weight: 1 });
    expect(fetchCalls.some((u) => /shipments\/announce/.test(u))).toBe(true);
  });
});
