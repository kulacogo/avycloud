// globals: true in vitest.config.js — describe/it/expect sind global
//
// Preis-Gate beim NEU-Einstellen (Audit 2026-07-29).
//
// Befund: 438 von 765 Bestandsprodukten haben keinen gesetzten
// `details.pricing.sellPrice`. Beim Einstellen faellt die Preis-Kette dann still auf
// `details.pricing.lowest_price.amount` zurueck — das ist aber nur der RECHERCHIERTE
// MARKTPREIS, kein bewusst entschiedener Verkaufspreis. Bei 408 Produkten ging genau
// dieser Wert als Angebotspreis online.
//
// Das Gate sitzt ausschliesslich in validatePublishReadiness (also nur im Publish-/
// Verify-Pfad). Laufende Angebote, Revise, Sync-Patches und Kaufland-Updates sind
// bewusst NICHT betroffen — sonst wuerden 408 Angebote beim naechsten Abgleich kippen.
//
// Drei Modi ueber REQUIRE_EXPLICIT_SELLPRICE:
//   off   (Default) — exakt heutiges Verhalten
//   warn            — Warnung, listet aber weiter
//   block           — Blocker

const { validatePublishReadiness } = require('../lib/ebay-direct');

function baseProduct(pricing) {
  return {
    id: 'p-price-gate',
    ops: { readiness: 'ready' },
    identification: { name: 'Testprodukt mit gutem Titel' },
    details: {
      categoryId: '33564',
      pricing,
      images: [{ url: 'https://storage.googleapis.com/x/bild1.jpg' }],
      identifiers: { ean: '4006633144780' },
      description: 'Eine ausreichend lange Beschreibung fuer das Produkt.',
    },
  };
}

const MARKTPREIS_NUR = { lowest_price: { amount: 509.99 } };
const ECHTER_VERKAUFSPREIS = { sellPrice: 479.9, lowest_price: { amount: 509.99 } };

const findet = (list, needle) => list.some((entry) => String(entry).includes(needle));

describe('Preis-Gate — Default aendert nichts', () => {
  const ENV_KEYS = ['REQUIRE_EXPLICIT_SELLPRICE'];
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

  it('blockt ohne gesetzte ENV nicht (heutiges Verhalten)', () => {
    delete process.env.REQUIRE_EXPLICIT_SELLPRICE;
    const r = validatePublishReadiness(baseProduct(MARKTPREIS_NUR));
    expect(findet(r.blockers, 'Verkaufspreis')).toBe(false);
    expect(findet(r.warnings, 'Verkaufspreis')).toBe(false);
  });

  it('behandelt einen unbekannten ENV-Wert wie off', () => {
    process.env.REQUIRE_EXPLICIT_SELLPRICE = 'vielleicht';
    const r = validatePublishReadiness(baseProduct(MARKTPREIS_NUR));
    expect(findet(r.blockers, 'Verkaufspreis')).toBe(false);
    expect(findet(r.warnings, 'Verkaufspreis')).toBe(false);
  });
});

describe('Preis-Gate — warn', () => {
  const ENV_KEYS = ['REQUIRE_EXPLICIT_SELLPRICE'];
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

  it('warnt beim stillen Marktpreis, blockt aber nicht', () => {
    process.env.REQUIRE_EXPLICIT_SELLPRICE = 'warn';
    const r = validatePublishReadiness(baseProduct(MARKTPREIS_NUR));
    expect(findet(r.warnings, 'Verkaufspreis')).toBe(true);
    expect(findet(r.blockers, 'Verkaufspreis')).toBe(false);
  });

  it('schweigt bei gesetztem Verkaufspreis', () => {
    process.env.REQUIRE_EXPLICIT_SELLPRICE = 'warn';
    const r = validatePublishReadiness(baseProduct(ECHTER_VERKAUFSPREIS));
    expect(findet(r.warnings, 'Verkaufspreis')).toBe(false);
  });
});

describe('Preis-Gate — block', () => {
  const ENV_KEYS = ['REQUIRE_EXPLICIT_SELLPRICE'];
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

  it('blockt das Neu-Einstellen beim stillen Marktpreis', () => {
    process.env.REQUIRE_EXPLICIT_SELLPRICE = 'block';
    const r = validatePublishReadiness(baseProduct(MARKTPREIS_NUR));
    expect(r.canPublish).toBe(false);
    expect(findet(r.blockers, 'Verkaufspreis')).toBe(true);
  });

  it('laesst Produkte mit gesetztem Verkaufspreis durch', () => {
    process.env.REQUIRE_EXPLICIT_SELLPRICE = 'block';
    const r = validatePublishReadiness(baseProduct(ECHTER_VERKAUFSPREIS));
    expect(findet(r.blockers, 'Verkaufspreis')).toBe(false);
  });

  it('laesst einen bewusst mitgegebenen Preis durch (Operator-Entscheidung)', () => {
    process.env.REQUIRE_EXPLICIT_SELLPRICE = 'block';
    const r = validatePublishReadiness(baseProduct(MARKTPREIS_NUR), { startPrice: 499 });
    expect(findet(r.blockers, 'Verkaufspreis')).toBe(false);
  });

  it('verdoppelt den bestehenden "Kein Preis"-Blocker nicht', () => {
    process.env.REQUIRE_EXPLICIT_SELLPRICE = 'block';
    const r = validatePublishReadiness(baseProduct({}));
    expect(findet(r.blockers, 'Kein Preis vorhanden')).toBe(true);
    expect(findet(r.blockers, 'Verkaufspreis')).toBe(false);
  });
});
