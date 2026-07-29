/**
 * Bearbeitungszeit (DispatchTimeMax) beim eBay-Einstellen.
 *
 * Ausgangslage (Audit 2026-07-29): Der Wert 3 stand als Literal an zwei Stellen im Code
 * (ebay-trading-api.js buildAddFixedPriceItemXml, ebay-direct.js mapProductToEbayItem).
 * eBay meldete im Angebotsqualitaetsbericht aber 2 Tage — die eBay-Verkaufsbedingung
 * (SellerProfiles/ShippingProfile) gewinnt gegenueber dem mitgesendeten Wert.
 *
 * Der Inhaber hat die Verkaufsbedingung auf "am selben Tag" umgestellt. Der Code darf dem
 * nicht in die Quere kommen und der feste Wert 3 darf keine Stolperfalle bleiben, falls
 * einmal kein Versandprofil gesetzt ist (dann ist DispatchTimeMax fuer eBay Pflicht).
 *
 * Zwei Flags, beide Default = exakt heutiges Verhalten:
 *   EBAY_DISPATCH_TIME_MAX              (Default 3)     — konfigurierbarer Wert
 *   EBAY_OMIT_DISPATCH_TIME_WITH_POLICY (Default false)  — Element weglassen, NUR mit Versandprofil
 */

const {
  buildAddFixedPriceItemXml,
  buildReviseItemRequestXml,
} = require('../lib/ebay-trading-api');

const CFG = { siteId: '77', currency: 'EUR' };

const baseItem = (extra = {}) => ({
  title: 'Testartikel',
  description: '<p>Beschreibung</p>',
  primaryCategoryId: '33089',
  startPrice: 19.9,
  quantity: 1,
  sku: 'SKU-DISPATCH-1',
  country: 'DE',
  postalCode: '42857',
  location: 'Remscheid',
  listingDuration: 'GTC',
  pictureUrls: ['https://example.com/a.jpg'],
  ...extra,
});

const dispatchOf = (xml) => {
  const m = xml.match(/<DispatchTimeMax>(\d+)<\/DispatchTimeMax>/);
  return m ? m[1] : null;
};

describe('DispatchTimeMax — Default bleibt byte-identisch zu heute', () => {
  const ENV_KEYS = ['EBAY_DISPATCH_TIME_MAX', 'EBAY_OMIT_DISPATCH_TIME_WITH_POLICY'];
  const saved = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    // Nur die eigenen Variablen zuruecksetzen. `process.env = {...}` wuerde die
    // GANZE Umgebung ersetzen und andere Testdateien im selben Worker beschaedigen.
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('sendet ohne gesetzte ENV weiterhin 3', () => {
    delete process.env.EBAY_DISPATCH_TIME_MAX;
    delete process.env.EBAY_OMIT_DISPATCH_TIME_WITH_POLICY;
    const xml = buildAddFixedPriceItemXml(baseItem(), CFG);
    expect(dispatchOf(xml)).toBe('3');
  });

  it('ein explizit uebergebener Wert am Item schlaegt die ENV (bestehendes Verhalten)', () => {
    process.env.EBAY_DISPATCH_TIME_MAX = '2';
    const xml = buildAddFixedPriceItemXml(baseItem({ dispatchTimeMax: 1 }), CFG);
    expect(dispatchOf(xml)).toBe('1');
  });
});

describe('DispatchTimeMax — konfigurierbar', () => {
  const ENV_KEYS = ['EBAY_DISPATCH_TIME_MAX', 'EBAY_OMIT_DISPATCH_TIME_WITH_POLICY'];
  const saved = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    // Nur die eigenen Variablen zuruecksetzen. `process.env = {...}` wuerde die
    // GANZE Umgebung ersetzen und andere Testdateien im selben Worker beschaedigen.
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('uebernimmt EBAY_DISPATCH_TIME_MAX=1 (Versand am naechsten Tag)', () => {
    process.env.EBAY_DISPATCH_TIME_MAX = '1';
    const xml = buildAddFixedPriceItemXml(baseItem(), CFG);
    expect(dispatchOf(xml)).toBe('1');
  });

  it('erlaubt 0 (Versand am selben Tag) — die Null darf nicht als "leer" durchfallen', () => {
    process.env.EBAY_DISPATCH_TIME_MAX = '0';
    const xml = buildAddFixedPriceItemXml(baseItem(), CFG);
    expect(dispatchOf(xml)).toBe('0');
  });

  it('faellt bei Unsinn auf 3 zurueck statt kaputtes XML zu bauen', () => {
    for (const bad of ['', '   ', 'abc', '-1', '99']) {
      process.env.EBAY_DISPATCH_TIME_MAX = bad;
      const xml = buildAddFixedPriceItemXml(baseItem(), CFG);
      expect(dispatchOf(xml)).toBe('3');
    }
  });
});

describe('DispatchTimeMax — der Verkaufsbedingung den Vortritt lassen', () => {
  const ENV_KEYS = ['EBAY_DISPATCH_TIME_MAX', 'EBAY_OMIT_DISPATCH_TIME_WITH_POLICY'];
  const saved = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    // Nur die eigenen Variablen zuruecksetzen. `process.env = {...}` wuerde die
    // GANZE Umgebung ersetzen und andere Testdateien im selben Worker beschaedigen.
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('laesst das Element weg, wenn ein Versandprofil gesetzt ist und das Flag an ist', () => {
    process.env.EBAY_OMIT_DISPATCH_TIME_WITH_POLICY = 'true';
    const xml = buildAddFixedPriceItemXml(baseItem({ shippingProfileId: '123456789' }), CFG);
    expect(xml).not.toContain('<DispatchTimeMax>');
    expect(xml).toContain('<SellerShippingProfile>');
  });

  it('sendet das Element WEITERHIN, wenn kein Versandprofil gesetzt ist (eBay-Pflichtfeld)', () => {
    process.env.EBAY_OMIT_DISPATCH_TIME_WITH_POLICY = 'true';
    const xml = buildAddFixedPriceItemXml(baseItem(), CFG);
    expect(dispatchOf(xml)).toBe('3');
  });

  it('sendet das Element weiterhin, wenn nur Rueckgabe-/Zahlungsprofil gesetzt sind', () => {
    process.env.EBAY_OMIT_DISPATCH_TIME_WITH_POLICY = 'true';
    const xml = buildAddFixedPriceItemXml(
      baseItem({ returnProfileId: '111', paymentProfileId: '222' }),
      CFG
    );
    expect(dispatchOf(xml)).toBe('3');
  });

  it('ignoriert das Flag solange es aus ist (Default)', () => {
    delete process.env.EBAY_OMIT_DISPATCH_TIME_WITH_POLICY;
    const xml = buildAddFixedPriceItemXml(baseItem({ shippingProfileId: '123456789' }), CFG);
    expect(dispatchOf(xml)).toBe('3');
  });
});

describe('DispatchTimeMax — Revise fasst die Bearbeitungszeit nicht an', () => {
  it('das Revise-XML enthaelt kein DispatchTimeMax (laufende Angebote bleiben unberuehrt)', () => {
    const xml = buildReviseItemRequestXml(
      'ReviseFixedPriceItem',
      { itemId: '800314905199', title: 'Neuer Titel' },
      CFG
    );
    expect(xml).not.toContain('DispatchTimeMax');
  });
});
