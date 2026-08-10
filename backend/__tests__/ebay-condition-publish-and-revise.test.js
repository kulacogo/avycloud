/**
 * Artikelzustand (ConditionID) im Publish- und Revise-Pfad.
 *
 * ZWEI GETRENNTE ANLIEGEN:
 *
 * 1. PUBLISH — der im Datenblatt gewaehlte Zustand muss im Angebot landen.
 *    Der Zustand ist bei eBay ein EIGENES Feld, kein Artikelmerkmal. Ohne
 *    Auswahl gilt weiterhin "Neu" (1000), damit sich am heutigen Verhalten
 *    nichts aendert.
 *
 * 2. REVISE — Regression: `reviseListingFromProduct` setzte frueher
 *    unbedingt `conditionId: item.conditionId`. Da `mapProductToEbayItem` ohne
 *    Datenblatt-Wert auf 1000 zurueckfaellt, schrieb JEDER inhaltliche Abgleich
 *    den Zustand auf "Neu". Ein per Hand auf "Gebraucht" gestelltes Angebot
 *    verlor seine Angabe stillschweigend. Dieser Test haelt das geschlossen.
 */

require('./api/_patchGcp');
require('./api/_patchLocalModules');

const { mapProductToEbayItem, validatePublishReadiness } = require('../lib/ebay-direct');

/** Minimalprodukt, das durch mapProductToEbayItem kommt. */
function makeProduct(overrides = {}) {
  // `details` wird gemischt, nicht ersetzt — sonst verliert jeder Testfall, der
  // nur die Kategorie setzen will, den Preis und mapProductToEbayItem wirft.
  const { details: detailOverrides, ...rest } = overrides;
  const details = {
    categoryId: '261581', // fuehrt 1000/1500/2500/3000/7000
    pricing: { sellPrice: 19.99 },
    images: ['https://example.com/a.jpg'],
    ...(detailOverrides || {}),
  };
  return {
    id: 'p1',
    identification: { name: 'Testartikel', brand: 'Testmarke' },
    details,
    inventory: { quantity: 3 },
    ops: { readiness: 'ready' },
    ...rest,
  };
}

describe('Artikelzustand — Publish', () => {
  it('ohne Auswahl bleibt es bei Neu (1000)', () => {
    const item = mapProductToEbayItem(makeProduct());
    expect(item.conditionId).toBe('1000');
  });

  it('uebernimmt den im Datenblatt gewaehlten Zustand', () => {
    const item = mapProductToEbayItem(makeProduct({ details: { categoryId: '261581', conditionId: '3000' } }));
    expect(item.conditionId).toBe('3000');
  });

  it('das Datenblatt schlaegt den aus eBay gespiegelten Wert', () => {
    // Frueher gewann marketplace.ebay.conditionId — damit haette ein Altwert
    // aus dem Angebot die menschliche Eingabe ueberstimmt.
    const product = makeProduct({
      details: { categoryId: '261581', conditionId: '3000' },
      marketplace: { ebay: { conditionId: '1000' } },
    });
    expect(mapProductToEbayItem(product).conditionId).toBe('3000');
  });

  it('ein ausdruecklicher Override schlaegt alles', () => {
    const product = makeProduct({ details: { categoryId: '261581', conditionId: '3000' } });
    expect(mapProductToEbayItem(product, { conditionId: '7000' }).conditionId).toBe('7000');
  });

  it('sendet "Zustand" NICHT als Artikelmerkmal', () => {
    const product = makeProduct({
      details: {
        categoryId: '261581',
        conditionId: '3000',
        attributes: { Zustand: 'Neu', Farbe: 'Schwarz' },
      },
    });
    const item = mapProductToEbayItem(product);
    const keys = Object.keys(item.itemSpecifics || {});
    expect(keys.some((k) => /^zustand$/i.test(k))).toBe(false);
    // Andere Merkmale bleiben unangetastet
    expect(keys.some((k) => /^farbe$/i.test(k))).toBe(true);
  });
});

describe('Artikelzustand — Publish-Pruefung', () => {
  it('blockt einen Zustand, den die Kategorie nicht fuehrt', () => {
    // 261588 (Bekleidung) fuehrt kein 7000 "Als Ersatzteil / defekt"
    const product = makeProduct({ details: { categoryId: '261588', conditionId: '7000', pricing: { sellPrice: 9.99 } } });
    const res = validatePublishReadiness(product);
    const hit = res.blockers.find((b) => /Artikelzustand .* nicht zulässig/i.test(b));
    expect(hit).toBeTruthy();
    // Die Meldung nennt die erlaubten Werte, damit sie ohne Nachschlagen loesbar ist
    expect(hit).toMatch(/Erlaubt:/);
  });

  it('laesst einen zulaessigen Zustand durch', () => {
    const product = makeProduct({ details: { categoryId: '261588', conditionId: '3000', pricing: { sellPrice: 9.99 } } });
    const res = validatePublishReadiness(product);
    expect(res.blockers.some((b) => /Artikelzustand/i.test(b))).toBe(false);
  });

  it('blockt nicht bei unbekannter Kategorie (fail-open)', () => {
    const product = makeProduct({ details: { categoryId: '99999999', conditionId: '7000', pricing: { sellPrice: 9.99 } } });
    const res = validatePublishReadiness(product);
    expect(res.blockers.some((b) => /Artikelzustand/i.test(b))).toBe(false);
  });
});

describe('Artikelzustand — Revise sendet ihn nur bewusst', () => {
  const { buildReviseItemRequestXml } = require('../lib/ebay-trading-api');
  const cfg = { userToken: 'tok', siteId: 77 };

  it('ohne conditionId im Patch steht KEIN ConditionID im XML', () => {
    // Das ist die Regression: frueher trug der Patch immer einen Wert (1000),
    // und jeder inhaltliche Abgleich hat damit den Zustand des Angebots
    // ueberschrieben. Fehlt das Feld, laesst eBay den Zustand unberuehrt.
    const xml = buildReviseItemRequestXml('ReviseFixedPriceItem', { itemId: '1234567890', title: 'Neuer Titel' }, cfg);
    expect(xml).not.toMatch(/<ConditionID>/);
  });

  it('mit conditionId im Patch steht er drin', () => {
    const xml = buildReviseItemRequestXml('ReviseFixedPriceItem', { itemId: '1234567890', conditionId: '3000' }, cfg);
    expect(xml).toMatch(/<ConditionID>3000<\/ConditionID>/);
  });

  it('undefined wird nicht als leeres Element gesendet', () => {
    // Zweites Feld noetig, sonst greift zu Recht der Waechter "keine
    // aenderbaren Felder" (nur ItemID im Request).
    const xml = buildReviseItemRequestXml(
      'ReviseFixedPriceItem',
      { itemId: '1234567890', title: 'Titel', conditionId: undefined },
      cfg
    );
    expect(xml).not.toMatch(/<ConditionID>/);
    expect(xml).toMatch(/<Title>/);
  });

  it('ein Revise nur mit Zustand ist moeglich', () => {
    // Wichtig fuer den Fall "nur der Zustand wurde im Datenblatt geaendert":
    // der Waechter zaehlt ConditionID als aenderbares Feld mit.
    const xml = buildReviseItemRequestXml('ReviseFixedPriceItem', { itemId: '1234567890', conditionId: '7000' }, cfg);
    expect(xml).toMatch(/<ConditionID>7000<\/ConditionID>/);
  });
});

describe('Artikelzustand — Fehlerklasse', () => {
  it('landet im Cockpit unter einer eigenen Klasse', () => {
    const { classifyListingError } = require('../lib/listing-error-classify');
    const res = classifyListingError('Artikelzustand 7000 ist in Kategorie 261588 nicht zulässig. Erlaubt: Neu mit Etikett (1000).');
    expect(res.groupKey).toBe('CONDITION_NOT_ALLOWED');
  });

  it('verwechselt sich nicht mit "Kategorie fehlt"', () => {
    const { classifyListingError } = require('../lib/listing-error-classify');
    expect(classifyListingError('Keine eBay-Kategorie zugewiesen.').groupKey).toBe('CATEGORY_MISSING');
  });
});
