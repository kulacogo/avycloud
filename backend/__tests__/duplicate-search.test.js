// globals: true in vitest.config.js
//
// Zusammenspiel der drei Stufen der Duplikat-Suche:
//   1. sicherer Schluessel (Marke + Herstellernummer) — deterministisch
//   2. Kandidaten (Modellnummer, Namensueberlappung) — deterministisch
//   3. KI-Urteil ueber die Kandidaten
//
// Der Schalter DEDUP_SEARCH steuert das Ganze: 'off' ist exakt das Verhalten
// von vor 2026-08-18 (nur Barcode-Vergleich in routes/identify.js).

const { searchExistingProduct } = require('../services/duplicate-search');

const produkt = (over = {}) => ({
  id: over.id || 'neu',
  identification: { name: over.name || '', brand: over.brand || '', barcodes: [] },
  details: { identifiers: { mpn: over.mpn || '' } },
});

const bestandVon = (...produkte) => {
  const { buildCatalogEntry } = require('../lib/product-match');
  const eintraege = produkte.map(buildCatalogEntry);
  return { entries: async () => eintraege };
};

const nieFragen = () => { throw new Error('KI haette nicht gefragt werden duerfen'); };

afterEach(() => { delete process.env.DEDUP_SEARCH; });

describe('searchExistingProduct', () => {
  it('tut bei abgeschaltetem Schalter gar nichts', async () => {
    process.env.DEDUP_SEARCH = 'off';
    const ergebnis = await searchExistingProduct({
      fresh: produkt({ brand: 'ATE', mpn: '13.0460-7256.2' }),
      index: { entries: nieFragen },
      judge: nieFragen,
    });

    expect(ergebnis.matchId).toBeNull();
    expect(ergebnis.stage).toBe('disabled');
  });

  it('nimmt den sicheren Schluessel ohne die KI zu fragen', async () => {
    process.env.DEDUP_SEARCH = 'on';
    const ergebnis = await searchExistingProduct({
      fresh: produkt({ brand: 'ATE', mpn: '1304607256 2', name: 'ATE Belagsatz' }),
      index: bestandVon(produkt({ id: 'alt', brand: 'ATE', mpn: '13.0460-7256.2', name: 'ATE Bremsbelagsatz' })),
      judge: nieFragen,
    });

    expect(ergebnis.matchId).toBe('alt');
    expect(ergebnis.stage).toBe('confirmed');
  });

  it('fragt die KI, wenn nur Kandidaten vorliegen', async () => {
    process.env.DEDUP_SEARCH = 'on';
    let gefragt = 0;
    const ergebnis = await searchExistingProduct({
      fresh: produkt({ brand: 'Philips', name: 'Philips LED TV 40PHS6000' }),
      index: bestandVon(produkt({ id: 'alt', brand: 'Philips', name: 'Philips 40PHS6000 LED Fernseher' })),
      judge: async () => { gefragt += 1; return { matchId: 'alt', verdict: 'same', confidence: 0.95 }; },
    });

    expect(gefragt).toBe(1);
    expect(ergebnis.matchId).toBe('alt');
    expect(ergebnis.stage).toBe('judged');
  });

  it('fragt die KI ohne Kandidaten nicht', async () => {
    process.env.DEDUP_SEARCH = 'on';
    const ergebnis = await searchExistingProduct({
      fresh: produkt({ brand: 'Philips', name: 'Philips Wasserkocher' }),
      index: bestandVon(produkt({ id: 'alt', brand: 'Philips', name: 'Philips 40PHS6000 LED Fernseher' })),
      judge: nieFragen,
    });

    expect(ergebnis.matchId).toBeNull();
    expect(ergebnis.stage).toBe('no_candidates');
  });

  it('entscheidet im Beobachtungsmodus, liefert den Treffer aber nicht aus', async () => {
    process.env.DEDUP_SEARCH = 'shadow';
    const ergebnis = await searchExistingProduct({
      fresh: produkt({ brand: 'ATE', mpn: '1304607256 2' }),
      index: bestandVon(produkt({ id: 'alt', brand: 'ATE', mpn: '13.0460-7256.2' })),
      judge: nieFragen,
    });

    expect(ergebnis.matchId).toBeNull();
    expect(ergebnis.shadowMatchId).toBe('alt');
  });

  it('reisst die Erfassung bei einem Fehler nicht ab', async () => {
    process.env.DEDUP_SEARCH = 'on';
    const ergebnis = await searchExistingProduct({
      fresh: produkt({ brand: 'ATE', name: 'ATE Belagsatz 40PHS6000' }),
      index: { entries: async () => { throw new Error('Index kaputt'); } },
      judge: nieFragen,
    });

    expect(ergebnis.matchId).toBeNull();
    expect(ergebnis.error).toBeTruthy();
  });
});

describe('searchExistingProduct — Absicherung des sicheren Treffers', () => {
  it('laesst die KI urteilen, wenn die Namen der gleichen Herstellernummer widersprechen', async () => {
    // Die Herstellernummer ist im Bestand nicht durchgaengig sauber gepflegt
    // (in derselben Datenbank standen schon Telefonnummern als EAN-8, siehe
    // Incident 2026-07-08). Traegt ein Produkt eine Serien- statt einer
    // Artikelnummer, wuerde ein blindes Reuse ein fremdes Datenblatt treffen.
    // Bei klar widersprechenden Bezeichnungen entscheidet deshalb die KI.
    process.env.DEDUP_SEARCH = 'on';
    let gefragt = 0;
    const ergebnis = await searchExistingProduct({
      fresh: produkt({ brand: 'Bosch', mpn: '1234567', name: 'Bosch Akkuschrauber GSR 12V' }),
      index: bestandVon(produkt({ id: 'alt', brand: 'Bosch', mpn: '1234567', name: 'Bosch Kuehlschrank KGN39' })),
      judge: async () => { gefragt += 1; return { matchId: null, verdict: 'different', confidence: 0.9 }; },
    });

    expect(gefragt).toBe(1);
    expect(ergebnis.matchId).toBeNull();
  });

  it('nimmt den sicheren Treffer bei uebereinstimmenden Namen weiterhin ohne KI', async () => {
    process.env.DEDUP_SEARCH = 'on';
    const ergebnis = await searchExistingProduct({
      fresh: produkt({ brand: 'Bosch', mpn: '1234567', name: 'Bosch Akkuschrauber GSR 12V' }),
      index: bestandVon(produkt({ id: 'alt', brand: 'Bosch', mpn: '1234567', name: 'Bosch Akkuschrauber GSR 12V Professional' })),
      judge: nieFragen,
    });

    expect(ergebnis.matchId).toBe('alt');
    expect(ergebnis.stage).toBe('confirmed');
  });

  it('nimmt den sicheren Treffer auch dann, wenn ein Name fehlt', async () => {
    // Ein leerer Name ist kein Widerspruch — die Nummer bleibt der Beleg.
    process.env.DEDUP_SEARCH = 'on';
    const ergebnis = await searchExistingProduct({
      fresh: produkt({ brand: 'Bosch', mpn: '1234567', name: '' }),
      index: bestandVon(produkt({ id: 'alt', brand: 'Bosch', mpn: '1234567', name: 'Bosch Akkuschrauber' })),
      judge: nieFragen,
    });

    expect(ergebnis.matchId).toBe('alt');
  });
});
