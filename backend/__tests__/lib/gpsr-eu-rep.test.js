'use strict';

const {
  DEFAULT_EU_REP,
  isNonEuManufacturer,
  hasEuRepFields,
  demixManufacturerEuRepContacts,
  buildResponsiblePersonFromGpsr,
  applyDefaultEuRep,
} = require('../../lib/gpsr-eu-rep');

describe('gpsr-eu-rep', () => {
  test('demix moves evatmaster contact out of manufacturer fields', () => {
    const input = {
      manufacturer_name: 'Zhaoqing Liwanjia Hardware Products Co., Ltd.',
      manufacturer_address: 'Yongli Industrial Park',
      manufacturer_city: 'Zhaoqing City',
      manufacturer_postalcode: '526105',
      entity_country: 'China',
      country_code: 'CN',
      email: 'contact@evatmaster.com',
      manufacturer_phone: '+49 6106 8218660 (EU Rep)',
    };
    const out = demixManufacturerEuRepContacts(input);
    expect(out.entity_country).toBe('China');
    expect(out.eu_responsible_name).toBe(DEFAULT_EU_REP.eu_responsible_name);
    expect(out.eu_responsible_email).toBe('contact@evatmaster.com');
    expect(out.email).toBeUndefined();
    expect(out.manufacturer_phone).toBeUndefined();
  });

  test('applyDefaultEuRep for non-EU manufacturer without rep', () => {
    const out = applyDefaultEuRep({
      manufacturer_name: 'Test Co',
      entity_country: 'China',
      country_code: 'CN',
    });
    expect(hasEuRepFields(out)).toBe(true);
    expect(out.eu_responsible_city).toBe('Rodgau');
  });

  test('buildResponsiblePersonFromGpsr returns EU rep for non-EU manufacturer', () => {
    const rp = buildResponsiblePersonFromGpsr({
      manufacturer_name: 'Test Co',
      entity_country: 'China',
      country_code: 'CN',
      eu_responsible_name: DEFAULT_EU_REP.eu_responsible_name,
      eu_responsible_address: DEFAULT_EU_REP.eu_responsible_address,
      eu_responsible_email: DEFAULT_EU_REP.eu_responsible_email,
    });
    expect(rp.companyName).toBe(DEFAULT_EU_REP.eu_responsible_name);
    expect(rp.countryCode).toBe('DE');
  });

  test('EU manufacturer does not get default EU rep forced', () => {
    const out = demixManufacturerEuRepContacts({
      manufacturer_name: 'Bosch GmbH',
      entity_country: 'Germany',
      country_code: 'DE',
      email: 'info@bosch.de',
    });
    expect(isNonEuManufacturer(out)).toBe(false);
    expect(hasEuRepFields(out)).toBe(false);
    expect(out.email).toBe('info@bosch.de');
  });
});
