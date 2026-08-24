'use strict';

/**
 * Duplikat-Suche in der Erfassung (Paket 1).
 *
 * Kernregel: Kandidaten werden DETERMINISTISCH gefunden, nie von der KI.
 * Ein sicherer Treffer ("confirmed") darf ohne Rueckfrage wiederverwendet
 * werden; alles andere ist hoechstens ein Kandidat fuer das KI-Urteil.
 *
 * Regressionsschutz gegen Incident 2026-07-08: zwei VERSCHIEDENE Artikel
 * derselben Marke duerfen NIE als sicherer Treffer gelten.
 */

const {
  normalizeMpn,
  buildCatalogEntry,
  findConfirmedMatch,
} = require('../lib/product-match');

const produkt = (over = {}) => ({
  id: over.id || 'p1',
  identification: {
    name: over.name || 'Produkt',
    brand: over.brand || '',
    barcodes: over.barcodes || [],
  },
  details: { identifiers: { mpn: over.mpn || '', sku: over.manufacturerSku || '' } },
});

describe('normalizeMpn', () => {
  it('macht Trennzeichen-Schreibweisen derselben Nummer gleich', () => {
    expect(normalizeMpn('13.0460-7256.2')).toBe(normalizeMpn('1304607256 2'));
  });

  it('haelt verschiedene ATE-Nummern auseinander', () => {
    expect(normalizeMpn('13.0460-7256.2')).not.toBe(normalizeMpn('13.0460-7195.2'));
  });

  it('verwirft Platzhalter statt sie zu einem Schluessel zu machen', () => {
    for (const junk of ['unknown', 'Unbekannt', 'n/a', '-', '', null, 'ke']) {
      expect(normalizeMpn(junk)).toBeNull();
    }
  });
});

describe('findConfirmedMatch', () => {
  it('erkennt dasselbe Produkt an Marke + Herstellernummer ohne Barcode', () => {
    const bestand = [buildCatalogEntry(produkt({ id: 'alt', brand: 'ATE', mpn: '13.0460-7256.2', name: 'ATE Bremsbelagsatz' }))];
    const frisch = produkt({ id: 'neu', brand: 'Ate GmbH', mpn: '1304607256 2', name: 'ATE Belagsatz vorne' });

    const treffer = findConfirmedMatch(frisch, bestand);

    expect(treffer?.id).toBe('alt');
    expect(treffer?.reason).toBe('mpn');
  });

  it('verweigert den Treffer bei gleicher Nummer aber anderer Marke', () => {
    // Herstellernummern sind nicht global eindeutig - "1234" von Bosch ist
    // nicht "1234" von ATE.
    const bestand = [buildCatalogEntry(produkt({ id: 'bosch', brand: 'Bosch', mpn: '1234567', name: 'Bosch Filter' }))];
    const frisch = produkt({ id: 'neu', brand: 'ATE', mpn: '1234567', name: 'ATE Filter' });

    expect(findConfirmedMatch(frisch, bestand)).toBeNull();
  });

  it('erklaert zwei verschiedene Artikel derselben Marke NICHT zum sicheren Treffer', () => {
    // Incident 2026-07-08: SONAX Scheibenreiniger vs SONAX CockpitPfleger.
    // Namens-Aehnlichkeit allein darf niemals ein Reuse ausloesen.
    const bestand = [buildCatalogEntry(produkt({ id: 'sonax-a', brand: 'SONAX', name: 'SONAX ScheibenReiniger Konzentrat' }))];
    const frisch = produkt({ id: 'neu', brand: 'SONAX', name: 'SONAX CockpitPfleger Lemon Rocks' });

    expect(findConfirmedMatch(frisch, bestand)).toBeNull();
  });

  it('nimmt eine fehlende Herstellernummer nicht als Uebereinstimmung', () => {
    const bestand = [buildCatalogEntry(produkt({ id: 'alt', brand: 'ATE', mpn: '', name: 'ATE Belagsatz' }))];
    const frisch = produkt({ id: 'neu', brand: 'ATE', mpn: '', name: 'ATE Belagsatz' });

    expect(findConfirmedMatch(frisch, bestand)).toBeNull();
  });
});

describe('selectCandidates', () => {
  const { selectCandidates } = require('../lib/product-match');

  const bestand = [
    produkt({ id: 'tv-alt', brand: 'Philips', name: 'Philips 40PHS6000 LED Fernseher 40 Zoll' }),
    produkt({ id: 'tv-anders', brand: 'Philips', name: 'Philips 32PFS5803 LED Fernseher 32 Zoll' }),
    produkt({ id: 'fremd', brand: 'Samsung', name: 'Samsung 40PHS6000 LED Fernseher' }),
  ].map(buildCatalogEntry);

  it('setzt den Treffer mit gleicher Modellnummer an die Spitze', () => {
    const frisch = produkt({ id: 'neu', brand: 'Philips', name: 'Philips LED TV 40PHS6000' });

    const kandidaten = selectCandidates(frisch, bestand);

    expect(kandidaten[0].id).toBe('tv-alt');
    expect(kandidaten[0].reasons).toContain('model_token');
  });

  it('schliesst eine andere Marke komplett aus, auch bei gleicher Modellnummer', () => {
    // Kern des Incidents 2026-07-08: verschiedene Hersteller duerfen nie
    // gemeinsam betrachtet werden.
    const frisch = produkt({ id: 'neu', brand: 'Philips', name: 'Philips LED TV 40PHS6000' });

    const ids = selectCandidates(frisch, bestand).map((k) => k.id);

    expect(ids).not.toContain('fremd');
  });

  it('schlaegt sich selbst nie als Kandidat vor', () => {
    const frisch = produkt({ id: 'tv-alt', brand: 'Philips', name: 'Philips 40PHS6000 LED Fernseher 40 Zoll' });

    expect(selectCandidates(frisch, bestand).map((k) => k.id)).not.toContain('tv-alt');
  });

  it('liefert nichts, wenn nur allgemeine Woerter uebereinstimmen', () => {
    const frisch = produkt({ id: 'neu', brand: 'Philips', name: 'Philips Wasserkocher' });

    expect(selectCandidates(frisch, bestand)).toEqual([]);
  });

  it('begrenzt die Kandidatenliste', () => {
    const viele = Array.from({ length: 20 }, (_, i) =>
      buildCatalogEntry(produkt({ id: `p${i}`, brand: 'Philips', name: 'Philips 40PHS6000 LED Fernseher' })));
    const frisch = produkt({ id: 'neu', brand: 'Philips', name: 'Philips 40PHS6000 LED Fernseher' });

    expect(selectCandidates(frisch, viele, { limit: 5 })).toHaveLength(5);
  });
});

describe('namensAehnlichkeit', () => {
  const { namensAehnlichkeit } = require('../lib/product-match');

  // Wort-Token taugen im Deutschen nicht: "Belagsatz" und "Bremsbelagsatz"
  // teilen kein einziges Wort, sind aber offensichtlich dasselbe Produkt.
  // Deshalb wird auf Zeichen-Ebene verglichen (Bigramm-Dice).
  //
  // Gemessen an realistischen Paaren (2026-08-18):
  //   gleich:      0,667 / 0,800 / 0,829 / 0,848
  //   verschieden: 0,267 / 0,275 / 0,400
  // Die Schwelle 0,5 liegt in der Luecke, mit Abstand zu beiden Seiten.

  it('erkennt deutsche Komposita desselben Produkts als aehnlich', () => {
    expect(namensAehnlichkeit('ATE Belagsatz', 'ATE Bremsbelagsatz')).toBeGreaterThan(0.5);
    expect(namensAehnlichkeit('Bosch Zuendkerze', 'Bosch Zuendkerzen 4er Set')).toBeGreaterThan(0.5);
  });

  it('erkennt umgestellte Titel desselben Produkts als aehnlich', () => {
    expect(namensAehnlichkeit('Philips 40PHS6000 LED Fernseher', 'Philips LED TV 40PHS6000')).toBeGreaterThan(0.5);
  });

  it('trennt verschiedene Artikel derselben Marke', () => {
    expect(namensAehnlichkeit('Bosch Akkuschrauber GSR 12V', 'Bosch Kuehlschrank KGN39')).toBeLessThan(0.5);
    expect(namensAehnlichkeit('SONAX ScheibenReiniger Konzentrat', 'SONAX CockpitPfleger Lemon Rocks')).toBeLessThan(0.5);
    expect(namensAehnlichkeit('Makita Bohrhammer HR2470', 'Makita Winkelschleifer GA9020')).toBeLessThan(0.5);
  });

  it('liefert 0 statt zu werfen, wenn ein Name fehlt', () => {
    expect(namensAehnlichkeit('', 'ATE Belagsatz')).toBe(0);
    expect(namensAehnlichkeit(null, undefined)).toBe(0);
  });
});
