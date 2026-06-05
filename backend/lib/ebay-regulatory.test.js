const {
  buildRegulatoryXml,
  buildManufacturerXml,
  normalizeManufacturerCountryCode,
} = require('./ebay-trading-api');

describe('normalizeManufacturerCountryCode', () => {
  test('passes through 2-letter ISO codes uppercased', () => {
    expect(normalizeManufacturerCountryCode('de')).toBe('DE');
    expect(normalizeManufacturerCountryCode('DE')).toBe('DE');
    expect(normalizeManufacturerCountryCode('Fr')).toBe('FR');
  });

  test('maps German country names to ISO-2', () => {
    expect(normalizeManufacturerCountryCode('Deutschland')).toBe('DE');
    expect(normalizeManufacturerCountryCode('Österreich')).toBe('AT');
    expect(normalizeManufacturerCountryCode('Schweiz')).toBe('CH');
  });

  test('maps English country names to ISO-2', () => {
    expect(normalizeManufacturerCountryCode('Germany')).toBe('DE');
    expect(normalizeManufacturerCountryCode('United Kingdom')).toBe('GB');
  });

  // Regression: the GPSR registry stores "UK" by marketplace convention, but
  // eBay's CountryCodeType only accepts ISO "GB". A bare "UK" previously passed
  // the 2-letter passthrough unchanged and triggered:
  //   "Eingabedaten für Tag <Item.Regulatory.Manufacturer.Country> ... ungültig oder fehlen"
  test('remaps non-ISO 2-letter aliases (UK->GB, EL->GR)', () => {
    expect(normalizeManufacturerCountryCode('UK')).toBe('GB');
    expect(normalizeManufacturerCountryCode('uk')).toBe('GB');
    expect(normalizeManufacturerCountryCode('EL')).toBe('GR');
  });

  test('full address with country_code "UK" emits <Country>GB</Country>', () => {
    const gpsr = {
      manufacturer_name: 'Taylor & Francis',
      manufacturer_address: '4 Park Square',
      manufacturer_city: 'Abingdon',
      manufacturer_postalcode: 'OX14 4RN',
      country_code: 'UK',
    };
    const xml = buildManufacturerXml(gpsr);
    expect(xml).toContain('<Country>GB</Country>');
    expect(xml).not.toContain('<Country>UK</Country>');
  });

  test('returns empty string for unknown or empty input', () => {
    expect(normalizeManufacturerCountryCode('')).toBe('');
    expect(normalizeManufacturerCountryCode(null)).toBe('');
    expect(normalizeManufacturerCountryCode('Atlantis')).toBe('');
  });
});

describe('buildManufacturerXml', () => {
  test('returns empty when gpsr is null or undefined', () => {
    expect(buildManufacturerXml(null)).toBe('');
    expect(buildManufacturerXml(undefined)).toBe('');
  });

  test('returns empty when manufacturer_name is missing', () => {
    expect(buildManufacturerXml({ manufacturer_address: 'Foo 1' })).toBe('');
  });

  // Regression: previously a bare name produced "<Manufacturer><CompanyName>X</CompanyName></Manufacturer>"
  // which eBay rejected with "mindestens eine Methode zur Kontaktaufnahme angeben".
  test('returns empty when only manufacturer_name is present (no contact method)', () => {
    expect(buildManufacturerXml({ manufacturer_name: 'Acme GmbH' })).toBe('');
  });

  test('returns empty when address is partial (missing postalcode)', () => {
    const gpsr = {
      manufacturer_name: 'Acme GmbH',
      manufacturer_address: 'Musterweg 1',
      manufacturer_city: 'Berlin',
      entity_country: 'Deutschland',
    };
    expect(buildManufacturerXml(gpsr)).toBe('');
  });

  test('emits full address block when all address fields are present', () => {
    const gpsr = {
      manufacturer_name: 'Acme GmbH',
      manufacturer_address: 'Musterweg 1',
      manufacturer_city: 'Berlin',
      manufacturer_postalcode: '10115',
      entity_country: 'Deutschland',
    };
    const xml = buildManufacturerXml(gpsr);
    expect(xml).toContain('<CompanyName>Acme GmbH</CompanyName>');
    expect(xml).toContain('<Street1>Musterweg 1</Street1>');
    expect(xml).toContain('<CityName>Berlin</CityName>');
    expect(xml).toContain('<PostalCode>10115</PostalCode>');
    expect(xml).toContain('<Country>DE</Country>');
  });

  // Regression: previously "Deutschland" was silently dropped because the XML
  // builder only emitted <Country> for inputs already of length 2.
  test('normalizes full country names to ISO-2 for CountryCode', () => {
    const gpsr = {
      manufacturer_name: 'Acme',
      manufacturer_address: 'Weg 1',
      manufacturer_city: 'Wien',
      manufacturer_postalcode: '1010',
      entity_country: 'Österreich',
    };
    expect(buildManufacturerXml(gpsr)).toContain('<Country>AT</Country>');
  });

  test('emits block with name + email only when address is incomplete', () => {
    const gpsr = {
      manufacturer_name: 'Acme',
      email: 'safety@acme.example',
    };
    const xml = buildManufacturerXml(gpsr);
    expect(xml).toBe(
      '<Manufacturer><CompanyName>Acme</CompanyName><Email>safety@acme.example</Email></Manufacturer>'
    );
  });

  test('emits block with name + phone only when address is incomplete', () => {
    const gpsr = {
      manufacturer_name: 'Acme',
      manufacturer_phone: '+49 30 1234567',
    };
    const xml = buildManufacturerXml(gpsr);
    expect(xml).toContain('<Phone>+49 30 1234567</Phone>');
    expect(xml).not.toContain('<Street1>');
  });

  test('drops address fields when country is unmappable but keeps email contact', () => {
    const gpsr = {
      manufacturer_name: 'Acme',
      manufacturer_address: 'Weg 1',
      manufacturer_city: 'Atlantis',
      manufacturer_postalcode: '00000',
      entity_country: 'Atlantis',
      email: 'info@acme.example',
    };
    const xml = buildManufacturerXml(gpsr);
    expect(xml).not.toContain('<Street1>');
    expect(xml).not.toContain('<Country>');
    expect(xml).toContain('<Email>info@acme.example</Email>');
  });

  test('escapes XML special characters', () => {
    const gpsr = {
      manufacturer_name: 'A & B <Ltd>',
      email: 'info@a-b.example',
    };
    const xml = buildManufacturerXml(gpsr);
    expect(xml).toContain('<CompanyName>A &amp; B &lt;Ltd&gt;</CompanyName>');
  });
});

describe('buildRegulatoryXml', () => {
  test('returns empty when neither gpsr nor responsiblePerson is set', () => {
    expect(buildRegulatoryXml({})).toBe('');
    expect(buildRegulatoryXml({ gpsr: null, responsiblePerson: null })).toBe('');
  });

  // Regression: the previous implementation emitted "<Regulatory><Manufacturer>
  // <CompanyName>X</CompanyName></Manufacturer></Regulatory>" which caused the
  // listing rejection. Now the incomplete Manufacturer is dropped; if there is
  // no responsiblePerson either, the whole <Regulatory> block is omitted.
  test('omits <Regulatory> entirely when only incomplete gpsr is given', () => {
    expect(buildRegulatoryXml({ gpsr: { manufacturer_name: 'Acme' } })).toBe('');
  });

  test('emits Regulatory with ResponsiblePerson even if Manufacturer is incomplete', () => {
    const xml = buildRegulatoryXml({
      gpsr: { manufacturer_name: 'Acme' }, // incomplete → dropped
      responsiblePerson: {
        companyName: 'TrendOcean',
        street: 'Hauptstr. 1',
        city: 'Köln',
        postalCode: '50667',
        countryCode: 'DE',
        email: 'rp@trendocean.example',
      },
    });
    expect(xml).not.toContain('<Manufacturer>');
    expect(xml).toContain('<ResponsiblePerson>');
    expect(xml).toContain('<Type>EUResponsiblePerson</Type>');
  });

  test('emits both Manufacturer and ResponsiblePerson when each has enough data', () => {
    const xml = buildRegulatoryXml({
      gpsr: {
        manufacturer_name: 'Acme GmbH',
        manufacturer_address: 'Musterweg 1',
        manufacturer_city: 'Berlin',
        manufacturer_postalcode: '10115',
        entity_country: 'Deutschland',
        email: 'safety@acme.example',
      },
      responsiblePerson: {
        companyName: 'TrendOcean',
        email: 'rp@trendocean.example',
        countryCode: 'DE',
      },
    });
    expect(xml.startsWith('<Regulatory>')).toBe(true);
    expect(xml.endsWith('</Regulatory>')).toBe(true);
    expect(xml).toContain('<Manufacturer>');
    expect(xml).toContain('<ResponsiblePerson>');
  });
});
