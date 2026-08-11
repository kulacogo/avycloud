// REGRESSION GUARD — USt-IdNr. bei Auslandssendungen (2026-08-10):
//
// Symptom am Packtisch: "SendCloud Announcement failed: Für Auslandssendungen
// geben Sie bitte Ihre USt-IdNr. in Ihren Benutzerdaten an." bei DPD Classic
// Europa (Aufträge 18-14989-91354 → IT, 08-15012-44206 → NL). Die USt-IdNr.
// WAR bei SendCloud hinterlegt — gemessen an der echten API:
//   GET /user/addresses/sender → id 825177, vat_number "DE…" (gesetzt)
//   GET /user                  → kennt gar kein VAT-Feld
//
// Ursache: die USt-IdNr. hängt AUSSCHLIESSLICH am gespeicherten Absender-
// Datensatz. Seit der v3-Migration schickt der Announce aber eine vollständige
// INLINE-Adresse (Schema-Zweig `address-with-required-fields`) — eine Kopie
// ohne Steuerfelder. Das v3-`address`-Objekt hat überhaupt kein VAT-Feld
// (verifiziert gegen das OpenAPI-Schema), die Nummer KANN dort also nie
// mitreisen. SendCloud sieht einen Absender ohne USt-IdNr. → Auslandssendung
// abgelehnt. Inlandssendungen brauchen sie nicht, deshalb fiel es nie auf.
//
// Fix: für Auslandssendungen `from_address: { sender_address_id }` — dann zieht
// SendCloud den gespeicherten Datensatz inkl. vat_number/eori_number.
// Gegen die echte API verifiziert: Mischen ist verboten
// ("Provide either 'sender_address_id' or address fields in 'from_address',
// not both."), deshalb ist das ein ENTWEDER/ODER, kein Zusatzfeld.
//
// Inland bleibt bewusst auf der Inline-Adresse: dort ist die Absenderzeile
// seit Incident 2026-07-21 exakt eingestellt (nur Firmenname, keine Doppelung,
// nie "-" als Hausnummer). Kein Grund, den funktionierenden 99-%-Pfad anzufassen.

require('./api/_patchGcp');

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
      {
        id: 825177,
        companyName: 'TrendOcean GmbH',
        contactName: 'Kundensupport',
        street: 'Gahmener Str.',
        houseNumber: '185',
        city: 'Lünen',
        postalCode: '44532',
        country: 'DE',
      },
    ]),
  },
  children: [], paths: [],
};

const { createParcel, _resolveAnnounceFromAddress } = require('../services/shipping-engine');

const DE_FROM = {
  name: 'TrendOcean GmbH',
  address_line_1: 'Gahmener Str.',
  house_number: '185',
  city: 'Lünen',
  postal_code: '44532',
  country_code: 'DE',
};

function order(country, zip, city) {
  return {
    id: `order-${country}`,
    marketplaceOrderId: '18-14989-91354',
    marketplace: 'ebay',
    customer: { name: 'Mario Rossi', street: 'Via Roma 1', city, zip, country },
    items: [{ quantity: 1, weight: 14 }],
  };
}

function v3FetchMock() {
  const option = {
    code: 'dpd:classic',
    carrier: { code: 'dpd', name: 'DPD' },
    product: { code: 'classic', name: 'DPD Classic Europa' },
    weight: { min: { value: '0.01' }, max: { value: '31.5' } },
    quotes: [{ price: { total: { value: '12.90' } } }],
  };
  const shipment = {
    id: 'shp_1',
    carrier: { code: 'dpd' },
    parcels: [{
      id: 123,
      tracking_number: 'TRACK123',
      status: { code: 'announced', message: 'ready to send' },
      documents: [{ type: 'label', size: 'a6', link: 'https://sendcloud/label.pdf' }],
    }],
  };
  return vi.fn((url) => {
    const body = String(url).includes('/shipping-options') ? { data: [option] } : { data: shipment };
    return Promise.resolve({ ok: true, text: async () => JSON.stringify(body), json: async () => body });
  });
}

function announceBody(fetchSpy) {
  const call = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/shipments/announce'));
  return JSON.parse(call[1].body);
}

describe('_resolveAnnounceFromAddress — Absenderform je Ziel', () => {
  afterEach(() => { delete process.env.SENDCLOUD_SENDER_ADDRESS_REF; });

  it('Ausland: referenziert den gespeicherten Absender (trägt die USt-IdNr.)', () => {
    const out = _resolveAnnounceFromAddress({ fromAddress: DE_FROM, senderAddressId: 825177, toCountry: 'IT' });
    expect(out).toEqual({ sender_address_id: 825177 });
  });

  it('Inland: unveränderte Inline-Adresse (Label-Fix 2026-07-21 bleibt intakt)', () => {
    const out = _resolveAnnounceFromAddress({ fromAddress: DE_FROM, senderAddressId: 825177, toCountry: 'DE' });
    expect(out).toBe(DE_FROM);
  });

  it('mischt NIE id und Adressfelder — SendCloud lehnt beides zusammen ab', () => {
    const out = _resolveAnnounceFromAddress({ fromAddress: DE_FROM, senderAddressId: 825177, toCountry: 'NL' });
    expect(Object.keys(out)).toEqual(['sender_address_id']);
    expect(out.address_line_1).toBeUndefined();
  });

  it('ohne bekannte Absender-ID: Inline-Adresse statt sender_address_id:undefined', () => {
    const out = _resolveAnnounceFromAddress({ fromAddress: DE_FROM, senderAddressId: null, toCountry: 'IT' });
    expect(out).toBe(DE_FROM);
  });

  it('SENDCLOUD_SENDER_ADDRESS_REF=off stellt exakt das alte Verhalten her', () => {
    process.env.SENDCLOUD_SENDER_ADDRESS_REF = 'off';
    const out = _resolveAnnounceFromAddress({ fromAddress: DE_FROM, senderAddressId: 825177, toCountry: 'IT' });
    expect(out).toBe(DE_FROM);
  });
});

describe('createParcel — Auslandssendung sendet die USt-IdNr.-tragende Absenderreferenz', () => {
  afterEach(() => {
    if (global.fetch && global.fetch.mockRestore) global.fetch.mockRestore();
    vi.restoreAllMocks();
  });

  it('IT (DPD Classic Europa): from_address = { sender_address_id }', async () => {
    const fetchSpy = v3FetchMock();
    global.fetch = fetchSpy;

    await createParcel({ order: order('IT', '00100', 'Roma'), weight: 14, requestLabel: false });

    const body = announceBody(fetchSpy);
    expect(body.from_address).toEqual({ sender_address_id: 825177 });
    expect(body.to_address.country_code).toBe('IT');
  });

  it('DE: Inline-Absenderadresse bleibt Zeichen für Zeichen wie bisher', async () => {
    const fetchSpy = v3FetchMock();
    global.fetch = fetchSpy;

    await createParcel({ order: order('DE', '44532', 'Lünen'), weight: 14, requestLabel: false });

    const body = announceBody(fetchSpy);
    expect(body.from_address.sender_address_id).toBeUndefined();
    expect(body.from_address.name).toBe('TrendOcean GmbH');
    expect(body.from_address.address_line_1).toBe('Gahmener Str.');
    expect(body.from_address.house_number).toBe('185');
  });
});
