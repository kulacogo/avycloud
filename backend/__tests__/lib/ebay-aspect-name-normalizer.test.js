'use strict';

// Reine Bibliothek — kein Firestore, kein eBay, kein GCP.
const {
  normalizeAspectNamesForCategory,
  normalizeAspectToken,
  buildCatalogNameIndex,
  getSynonymTable,
  MODES,
} = require('../../lib/ebay-aspect-name-normalizer');

const CATALOG = ['Marke', 'Material', 'Farbe', 'Besonderheiten', 'Ursprungsland', 'Abteilung'];

function run(overrides) {
  return normalizeAspectNamesForCategory({
    categoryId: '15709',
    catalogAspectNames: CATALOG,
    ...overrides,
  });
}

describe('ebay-aspect-name-normalizer / Modi', () => {
  const input = { Materialzusammensetzung: ['Baumwolle'], Marke: ['Nike'] };

  test('mode off ist Default und gibt die Eingabe unverändert zurück', () => {
    const res = normalizeAspectNamesForCategory({
      categoryId: '15709',
      catalogAspectNames: CATALOG,
      itemSpecifics: input,
    });
    expect(res.mode).toBe('off');
    expect(res.itemSpecifics).toEqual(input);
    expect(Object.keys(res.itemSpecifics)).toEqual(['Materialzusammensetzung', 'Marke']);
    expect(res.renames).toEqual([]);
    expect(res.unknown).toEqual([]);
    expect(res.changed).toBe(false);
  });

  test('mode shadow lässt die Eingabe unverändert, füllt aber renames/unknown', () => {
    const res = run({ itemSpecifics: { ...input, Quatschfeld: ['x'] }, mode: 'shadow' });
    expect(res.mode).toBe('shadow');
    expect(Object.keys(res.itemSpecifics)).toEqual(['Materialzusammensetzung', 'Marke', 'Quatschfeld']);
    expect(res.itemSpecifics.Materialzusammensetzung).toEqual(['Baumwolle']);
    expect(res.renames).toEqual([{ from: 'Materialzusammensetzung', to: 'Material' }]);
    expect(res.unknown.map((u) => u.name)).toEqual(['Quatschfeld']);
    expect(res.changed).toBe(false);
  });

  test('mode on benennt den Schlüssel um', () => {
    const res = run({ itemSpecifics: input, mode: 'on' });
    expect(res.mode).toBe('on');
    expect(res.itemSpecifics).toEqual({ Material: ['Baumwolle'], Marke: ['Nike'] });
    expect(res.renames).toEqual([{ from: 'Materialzusammensetzung', to: 'Material' }]);
    expect(res.changed).toBe(true);
  });

  test('unbekannter Modus fällt auf off zurück (fail-closed)', () => {
    const res = run({ itemSpecifics: input, mode: 'ON!' });
    expect(res.mode).toBe('off');
    expect(res.itemSpecifics).toEqual(input);
  });

  test('MODES exportiert genau die drei erlaubten Modi', () => {
    expect([...MODES].sort()).toEqual(['off', 'on', 'shadow']);
  });
});

describe('ebay-aspect-name-normalizer / Verlustfreiheit', () => {
  test('unbekannte Namen ohne Synonym bleiben stehen', () => {
    const res = run({ itemSpecifics: { Fantasiefeld: ['a'], 'Noch eins': ['b'] }, mode: 'on' });
    expect(res.itemSpecifics).toEqual({ Fantasiefeld: ['a'], 'Noch eins': ['b'] });
    expect(res.unknown.map((u) => u.name).sort()).toEqual(['Fantasiefeld', 'Noch eins']);
    expect(res.changed).toBe(false);
  });

  test('Synonym vorhanden, aber Zielname NICHT im Katalog → kein Rename, Wert bleibt', () => {
    const res = normalizeAspectNamesForCategory({
      categoryId: '999',
      catalogAspectNames: ['Marke'], // kein "Material"
      itemSpecifics: { Materialzusammensetzung: ['Baumwolle'] },
      mode: 'on',
    });
    expect(res.itemSpecifics).toEqual({ Materialzusammensetzung: ['Baumwolle'] });
    expect(res.renames).toEqual([]);
    expect(res.unknown).toEqual([{ name: 'Materialzusammensetzung', reason: 'target_missing' }]);
  });

  test('kein Schlüssel geht verloren — Anzahl bleibt gleich', () => {
    const itemSpecifics = {
      Materialzusammensetzung: ['Baumwolle'],
      Geschlecht: ['Herren'],
      Herstellungsland: ['Deutschland'],
      Blafasel: ['x'],
      Marke: ['Nike'],
    };
    const res = run({ itemSpecifics, mode: 'on' });
    expect(Object.keys(res.itemSpecifics)).toHaveLength(Object.keys(itemSpecifics).length);
  });

  test('Reihenfolge der Schlüssel bleibt erhalten', () => {
    const res = run({
      itemSpecifics: { Marke: ['Nike'], Materialzusammensetzung: ['Baumwolle'], Blafasel: ['x'] },
      mode: 'on',
    });
    expect(Object.keys(res.itemSpecifics)).toEqual(['Marke', 'Material', 'Blafasel']);
  });

  test('Eingabeobjekt wird nie mutiert', () => {
    const itemSpecifics = { Materialzusammensetzung: ['Baumwolle'] };
    run({ itemSpecifics, mode: 'on' });
    expect(itemSpecifics).toEqual({ Materialzusammensetzung: ['Baumwolle'] });
  });
});

describe('ebay-aspect-name-normalizer / Kollisionsschutz', () => {
  test('Zielname existiert bereits mit ANDEREM Wert → kein Rename', () => {
    const res = run({
      itemSpecifics: { Material: ['Leder'], Materialzusammensetzung: ['Baumwolle'] },
      mode: 'on',
    });
    expect(res.itemSpecifics).toEqual({ Material: ['Leder'], Materialzusammensetzung: ['Baumwolle'] });
    expect(res.renames).toEqual([]);
    expect(res.unknown).toEqual([{ name: 'Materialzusammensetzung', reason: 'collision' }]);
  });

  test('Zielname existiert bereits mit GLEICHEM Wert → Merge ohne Datenverlust', () => {
    const res = run({
      itemSpecifics: { Material: ['Baumwolle'], Materialzusammensetzung: ['Baumwolle'] },
      mode: 'on',
    });
    expect(res.itemSpecifics).toEqual({ Material: ['Baumwolle'] });
    expect(res.renames).toEqual([{ from: 'Materialzusammensetzung', to: 'Material' }]);
  });

  test('zwei Quellnamen auf dasselbe Ziel → nur der erste gewinnt, der zweite bleibt stehen', () => {
    const res = normalizeAspectNamesForCategory({
      categoryId: '15709',
      catalogAspectNames: CATALOG,
      itemSpecifics: { Materialzusammensetzung: ['Baumwolle'], Koffermaterial: ['ABS'] },
      mode: 'on',
    });
    expect(res.itemSpecifics).toEqual({ Material: ['Baumwolle'], Koffermaterial: ['ABS'] });
    expect(res.renames).toEqual([{ from: 'Materialzusammensetzung', to: 'Material' }]);
    expect(res.unknown).toEqual([{ name: 'Koffermaterial', reason: 'collision' }]);
  });

  test('bereits gültiger Katalogname wird nie umbenannt', () => {
    const res = run({ itemSpecifics: { Material: ['Leder'], Marke: ['Nike'] }, mode: 'on' });
    expect(res.itemSpecifics).toEqual({ Material: ['Leder'], Marke: ['Nike'] });
    expect(res.renames).toEqual([]);
    expect(res.unknown).toEqual([]);
  });
});

describe('ebay-aspect-name-normalizer / Werte', () => {
  test('Werte bleiben strikt unverändert (Referenzgleichheit)', () => {
    const values = ['Baumwolle', 'Polyester'];
    const res = run({ itemSpecifics: { Materialzusammensetzung: values }, mode: 'on' });
    expect(res.itemSpecifics.Material).toBe(values);
  });

  test('Nicht-Array-Werte werden unverändert durchgereicht', () => {
    const res = run({ itemSpecifics: { Materialzusammensetzung: 'Baumwolle' }, mode: 'on' });
    expect(res.itemSpecifics).toEqual({ Material: 'Baumwolle' });
  });

  test('leere Werte werden nicht weggeworfen', () => {
    const res = run({ itemSpecifics: { Materialzusammensetzung: [] }, mode: 'on' });
    expect(res.itemSpecifics).toEqual({ Material: [] });
  });
});

describe('ebay-aspect-name-normalizer / Randfälle', () => {
  test('leere Eingabe', () => {
    const res = run({ itemSpecifics: {}, mode: 'on' });
    expect(res.itemSpecifics).toEqual({});
    expect(res.renames).toEqual([]);
    expect(res.unknown).toEqual([]);
  });

  test('null/undefined Eingabe', () => {
    expect(run({ itemSpecifics: null, mode: 'on' }).itemSpecifics).toEqual({});
    expect(run({ itemSpecifics: undefined, mode: 'on' }).itemSpecifics).toEqual({});
    expect(normalizeAspectNamesForCategory().itemSpecifics).toEqual({});
  });

  test('unbekannte Kategorie (kein Katalog) → alles unverändert, nichts als unbekannt gemeldet', () => {
    const res = normalizeAspectNamesForCategory({
      categoryId: '4711',
      catalogAspectNames: [],
      itemSpecifics: { Materialzusammensetzung: ['Baumwolle'] },
      mode: 'on',
    });
    expect(res.catalogAvailable).toBe(false);
    expect(res.itemSpecifics).toEqual({ Materialzusammensetzung: ['Baumwolle'] });
    expect(res.renames).toEqual([]);
    expect(res.unknown).toEqual([]);
  });

  test('fehlende categoryId → no-op', () => {
    const res = normalizeAspectNamesForCategory({
      itemSpecifics: { Materialzusammensetzung: ['Baumwolle'] },
      catalogAspectNames: CATALOG,
      mode: 'on',
    });
    expect(res.itemSpecifics).toEqual({ Materialzusammensetzung: ['Baumwolle'] });
    expect(res.catalogAvailable).toBe(false);
  });

  test('technische Schlüssel (Kategorie, K-Typ) werden ignoriert, nicht als unbekannt gezählt', () => {
    const res = run({
      itemSpecifics: { Kategorie: ['Schuhe'], 'K-Typ': ['12345'], categoryId: ['15709'] },
      mode: 'on',
    });
    expect(res.unknown).toEqual([]);
    expect(res.renames).toEqual([]);
    expect(Object.keys(res.itemSpecifics)).toEqual(['Kategorie', 'K-Typ', 'categoryId']);
  });

  test('leerer Schlüsselname bleibt unangetastet', () => {
    const res = run({ itemSpecifics: { '': ['x'], '   ': ['y'] }, mode: 'on' });
    expect(res.itemSpecifics).toEqual({ '': ['x'], '   ': ['y'] });
    expect(res.unknown).toEqual([]);
  });

  test('Katalog als Objektzeilen ({name}) wird akzeptiert', () => {
    const res = normalizeAspectNamesForCategory({
      categoryId: '15709',
      catalogAspectNames: [{ name: 'Material' }, { name: 'Marke' }],
      itemSpecifics: { Materialzusammensetzung: ['Baumwolle'] },
      mode: 'on',
    });
    expect(res.itemSpecifics).toEqual({ Material: ['Baumwolle'] });
  });

  test('Zielname wird in der Schreibweise des Katalogs übernommen', () => {
    const res = normalizeAspectNamesForCategory({
      categoryId: '15709',
      catalogAspectNames: ['MATERIAL'],
      itemSpecifics: { Materialzusammensetzung: ['Baumwolle'] },
      mode: 'on',
    });
    expect(res.itemSpecifics).toEqual({ MATERIAL: ['Baumwolle'] });
    expect(res.renames).toEqual([{ from: 'Materialzusammensetzung', to: 'MATERIAL' }]);
  });
});

describe('ebay-aspect-name-normalizer / Idempotenz', () => {
  test('zweiter Durchlauf ändert nichts mehr', () => {
    const first = run({
      itemSpecifics: { Materialzusammensetzung: ['Baumwolle'], Geschlecht: ['Herren'], Blafasel: ['x'] },
      mode: 'on',
    });
    const second = run({ itemSpecifics: first.itemSpecifics, mode: 'on' });
    expect(second.itemSpecifics).toEqual(first.itemSpecifics);
    expect(second.renames).toEqual([]);
    expect(second.changed).toBe(false);
  });

  test('zyklische Synonympaare erzeugen keine Endlosumbenennung', () => {
    // Verschluss <-> Verschlussart sind wechselseitig eingetragen.
    const cat = ['Verschluss'];
    const a = normalizeAspectNamesForCategory({
      categoryId: '1',
      catalogAspectNames: cat,
      itemSpecifics: { Verschlussart: ['Reißverschluss'] },
      mode: 'on',
    });
    expect(a.itemSpecifics).toEqual({ Verschluss: ['Reißverschluss'] });
    const b = normalizeAspectNamesForCategory({
      categoryId: '1',
      catalogAspectNames: cat,
      itemSpecifics: a.itemSpecifics,
      mode: 'on',
    });
    expect(b.itemSpecifics).toEqual({ Verschluss: ['Reißverschluss'] });
    expect(b.renames).toEqual([]);
  });
});

describe('ebay-aspect-name-normalizer / Synonymtabelle + Helfer', () => {
  test('normalizeAspectToken normalisiert Umlaute und Sonderzeichen', () => {
    expect(normalizeAspectToken('Größe')).toBe('size');
    expect(normalizeAspectToken('Gewicht (kg)')).toBe('gewichtkg');
    expect(normalizeAspectToken('Marke')).toBe('brand');
    expect(normalizeAspectToken('Brand')).toBe('brand');
    expect(normalizeAspectToken('EAN')).toBe('gtin');
    expect(normalizeAspectToken(null)).toBe('');
  });

  test('buildCatalogNameIndex mappt Token auf den Katalognamen', () => {
    const idx = buildCatalogNameIndex(['Material', 'Marke']);
    expect(idx.get('material')).toBe('Material');
    expect(idx.get('brand')).toBe('Marke');
    expect(idx.size).toBe(2);
  });

  test('Synonymtabelle ist gültig: Strings, nicht leer, kein Selbstverweis', () => {
    const table = getSynonymTable();
    const entries = Object.entries(table);
    expect(entries.length).toBeGreaterThan(10);
    entries.forEach(([from, targets]) => {
      expect(typeof from).toBe('string');
      expect(Array.isArray(targets)).toBe(true);
      expect(targets.length).toBeGreaterThan(0);
      targets.forEach((t) => {
        expect(typeof t).toBe('string');
        expect(t.trim()).not.toBe('');
        expect(normalizeAspectToken(t)).not.toBe(normalizeAspectToken(from));
      });
      // Kein Ziel darf auf den mehrdeutigen 'hoehe'-Sammeltoken fallen
      // (Höhe/Dicke/Stärke werden von normalizeAspectToken zusammengefaltet).
      targets.forEach((t) => expect(normalizeAspectToken(t)).not.toBe('hoehe'));
    });
  });

  test('eigene Synonymtabelle kann injiziert werden', () => {
    const res = normalizeAspectNamesForCategory({
      categoryId: '1',
      catalogAspectNames: ['Farbe'],
      itemSpecifics: { Farbton: ['Rot'] },
      mode: 'on',
      synonyms: { Farbton: ['Farbe'] },
    });
    expect(res.itemSpecifics).toEqual({ Farbe: ['Rot'] });
  });
});
