// globals: true in vitest.config.js
//
// Der Katalog-Index haelt den Produktbestand fuer die Duplikat-Suche im
// Speicher. Er ist klein genug dafuer (~1.700 Produkte; services/deduplication.js
// laedt ihn heute schon komplett mit limit(2000)).
//
// Wichtig ist das Verhalten bei Stoerungen: ein fehlgeschlagenes Nachladen darf
// den Index NIE leeren. Ein leerer Index findet keine Duplikate und die
// Erfassung wuerde stillschweigend wieder Dubletten anlegen.

const { createCatalogIndex } = require('../lib/catalog-index');

const produkt = (id, name, brand, mpn) => ({
  id,
  identification: { name, brand, barcodes: [] },
  details: { identifiers: { mpn: mpn || '' } },
});

describe('createCatalogIndex', () => {
  it('verdichtet geladene Produkte zu Vergleichs-Eintraegen', async () => {
    const index = createCatalogIndex({ load: async () => [produkt('a', 'ATE Belagsatz', 'ATE', '13.0460-7256.2')] });

    const eintraege = await index.entries();

    expect(eintraege).toHaveLength(1);
    expect(eintraege[0].id).toBe('a');
    expect(eintraege[0].mpnNorm).toBe('1304607256 2'.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  });

  it('laedt innerhalb der Gueltigkeit nicht erneut', async () => {
    let ladevorgaenge = 0;
    const index = createCatalogIndex({
      ttlMs: 60000,
      load: async () => { ladevorgaenge += 1; return [produkt('a', 'A', 'ATE')]; },
    });

    await index.entries();
    await index.entries();

    expect(ladevorgaenge).toBe(1);
  });

  it('laedt nach Ablauf der Gueltigkeit neu', async () => {
    let ladevorgaenge = 0;
    let jetzt = 1000;
    const index = createCatalogIndex({
      ttlMs: 500,
      now: () => jetzt,
      load: async () => { ladevorgaenge += 1; return [produkt('a', 'A', 'ATE')]; },
    });

    await index.entries();
    jetzt += 600;
    await index.entries();

    expect(ladevorgaenge).toBe(2);
  });

  it('behaelt den letzten guten Stand, wenn das Nachladen scheitert', async () => {
    let jetzt = 1000;
    let sollScheitern = false;
    const index = createCatalogIndex({
      ttlMs: 500,
      now: () => jetzt,
      load: async () => {
        if (sollScheitern) throw new Error('Firestore weg');
        return [produkt('a', 'ATE Belagsatz', 'ATE')];
      },
    });

    await index.entries();
    sollScheitern = true;
    jetzt += 600;
    const eintraege = await index.entries();

    expect(eintraege).toHaveLength(1);
    expect(eintraege[0].id).toBe('a');
  });

  it('liefert beim allerersten Fehler eine leere Liste statt zu werfen', async () => {
    const index = createCatalogIndex({ load: async () => { throw new Error('Firestore weg'); } });

    await expect(index.entries()).resolves.toEqual([]);
  });
});
