// REGRESSION GUARD — Absenderadresse auf DHL-/DPD-Labels (2026-07-21):
//
// Seit der v2→v3-Migration (2026-07-10) senden WIR die from_address im
// Announce mit. SendCloud liefert die Absenderadresse sauber getrennt
// (street: "Gahmener Str.", house_number: "185", contact_name), aber:
//   1. listSenderAddresses verwarf das Feld house_number komplett.
//   2. _getV3FromAddress parste die Nummer aus dem Street-String — dort ist
//      keine → splitAddressLine-Fallback lieferte houseNumber '-' und wir
//      sendeten house_number:"-" → Labels druckten "Gahmener Str. -".
//   3. name UND company_name bekamen beide den Firmennamen → "TrendOcean
//      GmbH TrendOcean GmbH" doppelt auf dem Label.

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
  exports: { lookupCsvPrice: vi.fn().mockResolvedValue(null), listSenderAddresses: vi.fn() },
  children: [], paths: [],
};

const { _buildV3FromAddress } = require('../services/shipping-engine');

describe('_buildV3FromAddress — Hausnummer + Namensfelder der Absenderadresse', () => {
  it('nutzt das separate house_number-Feld der SendCloud-API (Realfall TrendOcean)', () => {
    const addr = _buildV3FromAddress({
      companyName: 'TrendOcean GmbH',
      contactName: 'Kundensupport',
      street: 'Gahmener Str.',
      houseNumber: '185',
      city: 'Lünen',
      postalCode: '44532',
      country: 'DE',
    });
    expect(addr.address_line_1).toBe('Gahmener Str.');
    expect(addr.house_number).toBe('185');
    expect(addr.postal_code).toBe('44532');
    expect(addr.country_code).toBe('DE');
  });

  it('fällt auf Street-Split zurück, wenn die API kein house_number liefert', () => {
    const addr = _buildV3FromAddress({
      companyName: 'X',
      street: 'Musterweg 7a',
      houseNumber: '',
      city: 'Berlin',
      postalCode: '10115',
      country: 'DE',
    });
    expect(addr.address_line_1).toBe('Musterweg');
    expect(addr.house_number).toBe('7a');
  });

  it('sendet NIE "-" als Hausnummer — ohne Nummer bleibt house_number undefined', () => {
    const addr = _buildV3FromAddress({
      companyName: 'X',
      street: 'Gahmener Str.',
      houseNumber: '',
      city: 'Lünen',
      postalCode: '44532',
      country: 'DE',
    });
    expect(addr.house_number).toBeUndefined();
    expect(addr.address_line_1).toBe('Gahmener Str.');
  });

  it('name = Ansprechpartner, company_name = Firma (keine Doppelung auf dem Label)', () => {
    const addr = _buildV3FromAddress({
      companyName: 'TrendOcean GmbH',
      contactName: 'Kundensupport',
      street: 'Gahmener Str.',
      houseNumber: '185',
      city: 'Lünen',
      postalCode: '44532',
      country: 'DE',
    });
    expect(addr.name).toBe('Kundensupport');
    expect(addr.company_name).toBe('TrendOcean GmbH');
  });

  it('ohne contact_name: Firma nur EINMAL (name gesetzt, company_name weggelassen)', () => {
    const addr = _buildV3FromAddress({
      companyName: 'TrendOcean GmbH',
      contactName: '',
      street: 'Gahmener Str.',
      houseNumber: '185',
      city: 'Lünen',
      postalCode: '44532',
      country: 'DE',
    });
    expect(addr.name).toBe('TrendOcean GmbH');
    expect(addr.company_name).toBeUndefined();
  });
});
