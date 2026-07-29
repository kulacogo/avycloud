'use strict';

// globals: true in vitest.config.js — describe/it/expect sind global.
//
// REGRESSION GUARD — GPSR-Audit 2026-07-16.
//
// eBay-Regulatory (Manufacturer + EUResponsiblePerson) wurde bisher NUR beim
// Publish gesendet: buildReviseItemRequestXml (lib/ebay-trading-api.js)
// unterstuetzt den <Regulatory>-Block laengst, aber reviseListingFromProduct
// (lib/ebay-direct.js) uebergab gpsr/responsiblePerson nicht — GPSR-Korrekturen
// erreichten bestehende Listings also NIE. Diese Tests zementieren:
//   1. Der Revise-Patch enthaelt gpsr + responsiblePerson (EXAKT dieselbe
//      Ableitung wie beim Publish via mapProductToEbayItem).
//   2. Produkte OHNE GPSR senden weiterhin NICHTS (buildRegulatoryXml → ''):
//      kein versehentliches Loeschen/Ueberschreiben bestehender eBay-Daten.
//   3. Ein GPSR-Record ohne Kontaktweg emittiert KEINEN (unvollstaendigen)
//      Manufacturer-Block — gleicher Guard wie beim Publish.

// Deterministisch: ENV-Fallbacks fuer die Responsible Person duerfen das
// Testergebnis nicht beeinflussen.
for (const key of [
  'EBAY_RESPONSIBLE_PERSON_NAME',
  'EBAY_RESPONSIBLE_PERSON_STREET',
  'EBAY_RESPONSIBLE_PERSON_CITY',
  'EBAY_RESPONSIBLE_PERSON_ZIP',
  'EBAY_RESPONSIBLE_PERSON_COUNTRY',
  'EBAY_RESPONSIBLE_PERSON_PHONE',
  'EBAY_RESPONSIBLE_PERSON_EMAIL',
]) {
  delete process.env[key];
}

// Das ECHTE buildRegulatoryXml VOR dem require.cache-Patch sichern — exakt die
// Funktion, an die buildReviseItemRequestXml den Patch delegiert. Damit pruefen
// wir das reale "nichts senden bei fehlenden Feldern"-Verhalten.
const realTradingPath = require.resolve('../lib/ebay-trading-api');
const { buildRegulatoryXml } = require(realTradingPath);
delete require.cache[realTradingPath];

// ── require.cache-Patching (CJS — vi.mock interceptet require nicht) ────────

const listingCacheWrites = [];
const mockFirestore = {
  collection: (name) => {
    if (name === 'ebayListingsLive') {
      return {
        doc: () => ({
          get: async () => ({ exists: false }),
          set: async (data) => { listingCacheWrites.push(data); },
        }),
      };
    }
    return {
      doc: () => ({ get: async () => ({ exists: false }), set: async () => {}, update: async () => {} }),
      where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }), get: async () => ({ empty: true, docs: [] }) }),
      get: async () => ({ empty: true, docs: [] }),
      add: async () => {},
    };
  },
};

require.cache[require.resolve('../lib/firestore')] = {
  id: require.resolve('../lib/firestore'),
  filename: require.resolve('../lib/firestore'),
  loaded: true,
  exports: {
    firestore: mockFirestore,
    getAllProducts: async () => [],
    getAllProductsForTenant: async () => [],
    PRODUCTS_COLLECTION: 'products_v2',
  },
  children: [],
  paths: [],
};

const reviseFixedPriceCalls = [];
const reviseItemCalls = [];
require.cache[realTradingPath] = {
  id: realTradingPath,
  filename: realTradingPath,
  loaded: true,
  exports: {
    getItemDetails: async () => ({ item: { listingType: 'FixedPriceItem' } }),
    reviseFixedPriceItem: async (patch) => {
      reviseFixedPriceCalls.push(patch);
      return { ack: 'Success' };
    },
    reviseItem: async (patch) => {
      reviseItemCalls.push(patch);
      return { ack: 'Success' };
    },
    // Bearbeitungszeit-Auflaesung (2026-07-29): mapProductToEbayItem liest den
    // Default seit dem konfigurierbaren DispatchTimeMax hierher. Der Mock muss sie
    // mitbringen, sonst bricht der Revise-Pfad mit "not a function".
    resolveDefaultDispatchTimeMax: () => 3,
    // KEIN endItem/endFixedPriceItem im Mock: wuerde reviseListingFromProduct
    // jemals einen End-Pfad nehmen, wirft der Test mit "not a function"
    // (CLAUDE.md Punkt 14 — kein destruktiver Marktplatz-Fehlerpfad).
  },
  children: [],
  paths: [],
};

const { reviseListingFromProduct } = require('../lib/ebay-direct');

function baseProduct(overrides = {}) {
  return {
    id: 'prod-gpsr-revise-1',
    tenantId: 'default',
    identification: { sku: 'SKU-0000012345', name: 'WOTAN Bremsenreiniger 500 ml', brand: 'WOTAN' },
    inventory: { quantity: 3 },
    details: {
      categoryId: '179497',
      pricing: { sellPrice: 12.95 },
      images: ['https://storage.googleapis.com/avycloud-product-images/x/1.jpg'],
      ...overrides,
    },
  };
}

const NON_EU_GPSR = {
  manufacturer_name: 'Shenzhen Tooling Co., Ltd.',
  manufacturer_address: 'Bao An District, Building 7',
  manufacturer_city: 'Shenzhen',
  manufacturer_postalcode: '518000',
  country_code: 'CN',
  email: 'compliance@shenzhen-tooling.com',
  url: 'https://www.shenzhen-tooling.com',
  evidence: { status: 'verified', url: 'https://www.shenzhen-tooling.com/impressum', checked_at: '2026-07-16T00:00:00.000Z', method: 'direct' },
};

describe('reviseListingFromProduct — GPSR/Regulatory im Revise-Patch', () => {
  beforeEach(() => {
    reviseFixedPriceCalls.length = 0;
    reviseItemCalls.length = 0;
    listingCacheWrites.length = 0;
  });

  it('Produkt MIT GPSR → Patch enthaelt gpsr + responsiblePerson (gleiche Ableitung wie Publish)', async () => {
    const product = baseProduct({ gpsr: { ...NON_EU_GPSR } });

    const result = await reviseListingFromProduct('389900000001', product);

    expect(result.ok).toBe(true);
    expect(reviseFixedPriceCalls.length).toBe(1);
    const patch = reviseFixedPriceCalls[0];

    // gpsr = details.gpsr — unveraendert durchgereicht.
    expect(patch.gpsr).toEqual(product.details.gpsr);

    // Non-EU-Hersteller (CN) → EU-Rep-Default (eVatmaster, vertraglich fix —
    // lib/gpsr-eu-rep.js DEFAULT_EU_REP), exakt wie mapProductToEbayItem.
    expect(patch.responsiblePerson).toBeTruthy();
    expect(patch.responsiblePerson.companyName).toBe('eVatmaster Consulting GmbH');
    expect(patch.responsiblePerson.countryCode).toBe('DE');

    // Der ECHTE XML-Builder emittiert daraus Manufacturer + ResponsiblePerson.
    const xml = buildRegulatoryXml(patch);
    expect(xml).toContain('<Regulatory>');
    expect(xml).toContain('<Manufacturer>');
    expect(xml).toContain('Shenzhen Tooling Co., Ltd.');
    expect(xml).toContain('<ResponsiblePersons>');
    expect(xml).toContain('<Type>EUResponsiblePerson</Type>');

    // Minimal-Invariante: die uebrigen Felder bleiben wie bisher im Patch.
    expect(patch.itemId).toBe('389900000001');
    expect(patch.title).toBe('WOTAN Bremsenreiniger 500 ml');
  });

  it('Produkt OHNE GPSR → Patch traegt KEINE Regulatory-Daten und der XML-Builder sendet NICHTS', async () => {
    const product = baseProduct(); // kein details.gpsr

    const result = await reviseListingFromProduct('389900000002', product);

    expect(result.ok).toBe(true);
    expect(reviseFixedPriceCalls.length).toBe(1);
    const patch = reviseFixedPriceCalls[0];

    // Keine Regulatory-Werte im Patch …
    expect(patch.gpsr).toBeUndefined();
    expect(patch.responsiblePerson).toBeUndefined();
    // … und updatedFields listet sie nicht (null/undefined werden gefiltert).
    expect(result.updatedFields).not.toContain('gpsr');
    expect(result.updatedFields).not.toContain('responsiblePerson');

    // Der ECHTE Builder emittiert dann KEINEN <Regulatory>-Block — bestehende
    // eBay-Regulatory-Daten werden beim Revise nicht angefasst/geloescht.
    expect(buildRegulatoryXml(patch)).toBe('');
  });

  it('GPSR ohne Kontaktweg (nur Name) → kein Manufacturer-Block (gleicher Guard wie Publish)', async () => {
    const product = baseProduct({
      gpsr: {
        manufacturer_name: 'Robert Bosch GmbH',
        country_code: 'DE', // EU → keine Responsible Person noetig
      },
    });

    const result = await reviseListingFromProduct('389900000003', product);

    expect(result.ok).toBe(true);
    const patch = reviseFixedPriceCalls[0];
    // gpsr wird durchgereicht (Ableitung wie Publish) …
    expect(patch.gpsr).toEqual(product.details.gpsr);
    // … aber ohne Adresse/E-Mail/Telefon emittiert der Builder NICHTS —
    // eBay lehnt einen Manufacturer-Block ohne Kontaktweg ab.
    expect(buildRegulatoryXml(patch)).toBe('');
  });
});
