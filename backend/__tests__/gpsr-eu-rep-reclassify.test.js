'use strict';

const {
  looksLikeEuRepEntity,
  reclassifyEuRepAsManufacturer,
} = require('../lib/gpsr-eu-rep');

describe('looksLikeEuRepEntity', () => {
  it('detects the "(für X)" / "(for X)" on-behalf-of marker', () => {
    expect(looksLikeEuRepEntity('Apex CE Specialists GmbH (für Ominia)')).toBe(true);
    expect(looksLikeEuRepEntity('Some Company Ltd (for BrandX)')).toBe(true);
    expect(looksLikeEuRepEntity('Foo GmbH im Auftrag von BrandY')).toBe(true);
  });

  it('detects known professional EU-rep providers by name', () => {
    expect(looksLikeEuRepEntity('eVatmaster Consulting GmbH')).toBe(true);
    expect(looksLikeEuRepEntity('Apex CE Specialists GmbH')).toBe(true);
  });

  it('does NOT flag a normal manufacturer name', () => {
    expect(looksLikeEuRepEntity('BelleMax GmbH')).toBe(false);
    expect(looksLikeEuRepEntity('Bosch Hausgeräte GmbH')).toBe(false);
    expect(looksLikeEuRepEntity('')).toBe(false);
    expect(looksLikeEuRepEntity(null)).toBe(false);
  });
});

describe('reclassifyEuRepAsManufacturer', () => {
  it('moves an EU-rep mistakenly stored as manufacturer into eu_responsible_* and restores the real manufacturer from "(für X)"', () => {
    const gpsr = {
      manufacturer_name: 'Apex CE Specialists GmbH (für Ominia)',
      manufacturer_address: 'Grafenberger Allee 277',
      manufacturer_city: 'Düsseldorf',
      manufacturer_postalcode: '40237',
      manufacturer_state_province: 'Nordrhein-Westfalen',
      entity_country: 'Germany',
      country_code: 'DE',
      email: 'info@apex-ce.com',
      manufacturer_phone: '+4921186392011',
    };

    const out = reclassifyEuRepAsManufacturer(gpsr);

    // EU responsible person now holds the Apex CE data (name cleaned of the "(für …)" suffix)
    expect(out.eu_responsible_name).toBe('Apex CE Specialists GmbH');
    expect(out.eu_responsible_address).toBe('Grafenberger Allee 277');
    expect(out.eu_responsible_city).toBe('Düsseldorf');
    expect(out.eu_responsible_postalcode).toBe('40237');
    expect(out.eu_responsible_state_province).toBe('Nordrhein-Westfalen');
    expect(out.eu_responsible_country).toBe('Germany');
    expect(out.eu_responsible_country_code).toBe('DE');
    expect(out.eu_responsible_email).toBe('info@apex-ce.com');
    expect(out.eu_responsible_phone).toBe('+4921186392011');

    // The real manufacturer (Ominia) is restored; the rep's address/contact no longer pollute manufacturer_*
    expect(out.manufacturer_name).toBe('Ominia');
    expect(out.manufacturer_address || '').toBe('');
    expect(out.manufacturer_city || '').toBe('');
    expect(out.manufacturer_postalcode || '').toBe('');
    expect(out.email || '').toBe('');
    expect(out.manufacturer_phone || '').toBe('');
    // entity_country must NOT keep Germany (that was the rep's country, not Ominia's)
    expect(out.entity_country || '').toBe('');
    expect(out.country_code || '').toBe('');
  });

  it('leaves a legitimate manufacturer untouched', () => {
    const gpsr = {
      manufacturer_name: 'BelleMax GmbH',
      manufacturer_address: 'Musterstr. 1',
      manufacturer_city: 'Berlin',
      manufacturer_postalcode: '10115',
      entity_country: 'Germany',
      country_code: 'DE',
      email: 'kontakt@bellemax.de',
      manufacturer_phone: '+4930123456',
    };
    const out = reclassifyEuRepAsManufacturer(gpsr);
    expect(out).toEqual(gpsr);
  });

  it('does not overwrite an already-populated EU responsible person', () => {
    const gpsr = {
      manufacturer_name: 'Apex CE Specialists GmbH (für Ominia)',
      manufacturer_address: 'Grafenberger Allee 277',
      eu_responsible_name: 'Existing Rep GmbH',
      eu_responsible_address: 'Some Street 5',
    };
    const out = reclassifyEuRepAsManufacturer(gpsr);
    // existing EU rep preserved, no clobbering
    expect(out.eu_responsible_name).toBe('Existing Rep GmbH');
  });

  it('handles a provider name without a "(für X)" suffix (no manufacturer to restore)', () => {
    const gpsr = {
      manufacturer_name: 'eVatmaster Consulting GmbH',
      manufacturer_address: 'Raiffeisenstr. 2 B11',
      manufacturer_city: 'Rodgau',
      manufacturer_postalcode: '63110',
      entity_country: 'Germany',
      email: 'contact@evatmaster.com',
    };
    const out = reclassifyEuRepAsManufacturer(gpsr);
    expect(out.eu_responsible_name).toBe('eVatmaster Consulting GmbH');
    expect(out.eu_responsible_city).toBe('Rodgau');
    // no brand extractable → manufacturer_name cleared rather than left wrong
    expect(out.manufacturer_name || '').toBe('');
  });
});
