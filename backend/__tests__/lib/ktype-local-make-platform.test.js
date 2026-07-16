/**
 * local_make_platform-Pfad der K-Typ-Anreicherung (2026-07-16).
 *
 * Audit-Befund: 39 von 48 Rest-Produkten ohne K-Typ trugen die Fahrzeug-
 * Verwendung bereits im eigenen Titel ("… für Audi A4 B8 …"), aber der
 * Enricher nutzte Make+Plattform-Evidenz nur aus Web-Seiten. Der neue Pfad
 * mappt Titel/Kompatibilitäts-Attribute deterministisch gegen die MVL —
 * gleicher No-Guessing-Vertrag: nur exakte make|platform-Treffer zählen.
 *
 * Kein Netz: Beide Negativ-Fälle haben keine MPN, damit die Kette VOR dem
 * Web-Evidenz-Pfad endet (missing_part_number). MVL kommt aus einer Fixture
 * via MVL_JSONL_PATH; Modul wird mit frischem require.cache geladen.
 */

const path = require('path');

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'mvl-fixture.jsonl');
const MODULE_PATH = require.resolve('../../lib/ktype-enrichment');

function freshEnricher() {
  delete require.cache[MODULE_PATH];
  return require('../../lib/ktype-enrichment');
}

function productWith({ name, attributes = {}, mpn = '' } = {}) {
  return {
    id: `test-${Math.random().toString(36).slice(2)}`,
    identification: { name },
    details: {
      categoryId: '33580', // echte Auto-Fitment-Kategorie (Querlenker)
      attributes,
      identifiers: mpn ? { mpn } : {},
    },
  };
}

describe('K-Typ local_make_platform', () => {
  let prevMvlPath;

  beforeAll(() => {
    prevMvlPath = process.env.MVL_JSONL_PATH;
    process.env.MVL_JSONL_PATH = FIXTURE;
  });

  afterAll(() => {
    if (prevMvlPath === undefined) delete process.env.MVL_JSONL_PATH;
    else process.env.MVL_JSONL_PATH = prevMvlPath;
    delete require.cache[MODULE_PATH];
  });

  it('Titel "für Audi A4 B8 A6 C7" → K-Typ aus MVL make|platform (Union beider Plattformen)', async () => {
    const { enrichKTypIfPossible } = freshEnricher();
    const product = productWith({ name: 'ATEC Querlenker Vorne Rechts Unten Alu für Audi A4 B8 A6 C7' });
    const res = await enrichKTypIfPossible(product, { reason: 'test' });
    expect(res.ok).toBe(true);
    expect(product.details.attributes['K-Typ']).toBe('111|112|211');
    expect(product.ops.data_quality.ktype_enrich_v1.source).toBe('local_make_platform');
    expect(product.ops.data_quality.ktype_enrich_v1.matched).toEqual(
      expect.arrayContaining(['audi|B8', 'audi|C7'])
    );
  });

  it('Kompatibilitäts-Attribut ("Passend für") zählt als Evidenz', async () => {
    const { enrichKTypIfPossible } = freshEnricher();
    const product = productWith({
      name: 'Fußmatten Velours Schwarz 4-tlg',
      attributes: { 'Passend für': 'BMW 2er Active Tourer F45' },
    });
    const res = await enrichKTypIfPossible(product, { reason: 'test' });
    expect(res.ok).toBe(true);
    expect(product.details.attributes['K-Typ']).toBe('333');
  });

  it('KEIN Match ohne Fahrzeugmarke im Text — Teilenummern-Tokens dürfen nie allein matchen', async () => {
    const { enrichKTypIfPossible } = freshEnricher();
    // "B8" steht im Titel, aber keine MVL-Fahrzeugmarke → Make-Gate blockt.
    const product = productWith({ name: 'Bosch Bremsscheibe B8 belüftet, beschichtet' });
    const res = await enrichKTypIfPossible(product, { reason: 'test' });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('missing_part_number'); // fällt zur nächsten Stufe durch, kein Web-Call
    expect(product.details.attributes['K-Typ']).toBeUndefined();
  });

  it('MPN wird aus dem Evidenz-Text entfernt — Plattform-Token aus Teilenummer matcht nicht', () => {
    const { collectLocalFitmentText } = freshEnricher();
    // Titel enthält Fahrzeugmarke UND ein plattform-gleiches Token, das aber
    // Teil der MPN ist — excludeValues schneidet es aus dem Evidenz-Text.
    // (Kein enrich-Aufruf: Produkt mit MPN würde in den Web-Pfad laufen — kein Netz in Unit-Tests.)
    const product = productWith({ name: 'Zubehör für Honda Teile-Nr FK7', mpn: 'FK7' });
    const text = collectLocalFitmentText(product, { excludeValues: ['FK7'] });
    expect(text).toContain('Honda');
    expect(text).not.toContain('FK7');
  });

  it('Universal-Artikel ohne Fahrzeugbezug bleibt unangetastet', async () => {
    const { enrichKTypIfPossible } = freshEnricher();
    const product = productWith({ name: 'Kofferraum Organizer Netz Tasche Schwarz Klettbefestigung' });
    const res = await enrichKTypIfPossible(product, { reason: 'test' });
    expect(res.ok).toBe(false);
    expect(product.details.attributes['K-Typ']).toBeUndefined();
  });
});
