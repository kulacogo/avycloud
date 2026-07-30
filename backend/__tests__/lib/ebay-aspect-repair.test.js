/**
 * Aufbereitung der Artikelmerkmale, damit eBay sie als Suchfilter erkennt.
 *
 * Die wichtigsten Tests sind die ABLEHNUNGEN. Beim Messen an echten Daten hat ein zu
 * weites Klammer-Muster folgendes produziert:
 *   "Hersteller (Europa)" = "THULE SWEDEN AB"  ->  "Marke" = "THULE SWEDEN AB Europa"
 * Die GPSR-Herstellerfirma waere in den Marken-Filter gewandert, der Wert verstuemmelt.
 * 392 solche Faelle wurden gemessen. Deshalb: Positivliste echter Einheiten.
 */

const {
  repairAspectsForCategory,
  extractUnitFromName,
  appendUnitToValue,
  resolveRepairMode,
} = require('../../lib/ebay-aspect-repair');

// Kategorie-Katalog wie ihn lib/ebay-taxonomy liefert (Namen ohne Einheit).
const KATALOG = ['Marke', 'Herstellernummer', 'Gewicht', 'Material', 'Farbe', 'Produktart', 'Ursprungsland'];

const repair = (itemSpecifics, extra = {}) => repairAspectsForCategory({
  categoryId: '33089',
  itemSpecifics,
  catalogAspectNames: KATALOG,
  mode: 'on',
  ...extra,
});

describe('extractUnitFromName — Einheit erkennen, Nicht-Einheit ablehnen', () => {
  it('erkennt echte Einheiten', () => {
    expect(extractUnitFromName('Gewicht (kg)')).toEqual({ baseName: 'Gewicht', unit: 'kg' });
    expect(extractUnitFromName('Länge (cm)')).toEqual({ baseName: 'Länge', unit: 'cm' });
    expect(extractUnitFromName('Leistung (W)')).toEqual({ baseName: 'Leistung', unit: 'W' });
    expect(extractUnitFromName('Durchmesser (Zoll)')).toEqual({ baseName: 'Durchmesser', unit: 'Zoll' });
  });

  it('lehnt alles ab, was keine Einheit ist (der eigentliche Schutz)', () => {
    for (const name of [
      'Hersteller (Europa)',
      'Hersteller (USA)',
      'Herstellernummer (MPN)',
      'Verpackungsmaße (LxBxH)',
      'Abmessungen (L x B x H)',
      'Lüfterunterstützung (Gesamt)',
      'Schuhgröße (EU)',
    ]) {
      expect(extractUnitFromName(name)).toBe(null);
    }
  });

  it('liefert null ohne Klammerteil und bei Muell', () => {
    expect(extractUnitFromName('Gewicht')).toBe(null);
    expect(extractUnitFromName('')).toBe(null);
    expect(extractUnitFromName(null)).toBe(null);
    expect(extractUnitFromName('()')).toBe(null);
  });
});

describe('appendUnitToValue — Einheit in den Wert, idempotent', () => {
  it('haengt die Einheit an', () => {
    expect(appendUnitToValue('16', 'kg')).toBe('16 kg');
    expect(appendUnitToValue('0.5', 'kg')).toBe('0.5 kg');
  });

  it('haengt nicht doppelt an', () => {
    expect(appendUnitToValue('16 kg', 'kg')).toBe('16 kg');
    expect(appendUnitToValue('16kg', 'kg')).toBe('16kg');
    expect(appendUnitToValue('16 KG', 'kg')).toBe('16 KG');
  });

  it('laesst leere Werte leer', () => {
    expect(appendUnitToValue('', 'kg')).toBe('');
  });
});

describe('Regel 1 — Einheit aus dem Namen in den Wert', () => {
  it('macht aus "Gewicht (kg)"="16" ein "Gewicht"="16 kg"', () => {
    const r = repair({ 'Gewicht (kg)': '16' });
    expect(r.itemSpecifics).toEqual({ Gewicht: '16 kg' });
    expect(r.aenderungen.some((a) => a.art === 'einheit')).toBe(true);
  });

  it('fasst "Hersteller (Europa)" NICHT an', () => {
    const r = repair({ 'Hersteller (Europa)': 'THULE SWEDEN AB' });
    expect(r.itemSpecifics).toEqual({ 'Hersteller (Europa)': 'THULE SWEDEN AB' });
    expect(r.itemSpecifics.Marke).toBeUndefined();
  });

  it('benennt nicht um, wenn der Zielname schon belegt ist (kein Datenverlust)', () => {
    const r = repair({ 'Gewicht (kg)': '16', Gewicht: '15,95 kg' });
    expect(r.itemSpecifics['Gewicht (kg)']).toBe('16');
    expect(r.itemSpecifics.Gewicht).toBe('15,95 kg');
  });

  it('benennt nicht um, wenn der Zielname im Katalog fehlt', () => {
    const r = repair({ 'Spannung (V)': '230' });
    expect(r.itemSpecifics).toEqual({ 'Spannung (V)': '230' });
  });

  it('ist idempotent — zweimal angewendet aendert nichts mehr', () => {
    const eins = repair({ 'Gewicht (kg)': '16' });
    const zwei = repair(eins.itemSpecifics);
    expect(zwei.itemSpecifics).toEqual(eins.itemSpecifics);
    expect(zwei.changed).toBe(false);
  });
});

describe('Regel 2 — falsch platzierte Merkmale entfernen', () => {
  it('entfernt Zustand und EAN', () => {
    const r = repair({ Zustand: 'Neu', EAN: '4030623418186', Marke: 'FAMEX' });
    expect(r.itemSpecifics).toEqual({ Marke: 'FAMEX' });
    expect(r.aenderungen.filter((a) => a.art === 'entfernt').length).toBe(2);
  });

  it('entfernt GTIN, UPC, ISBN und Artikelzustand', () => {
    const r = repair({ GTIN: '1', UPC: '2', ISBN: '3', Artikelzustand: 'Neu', Marke: 'X' });
    expect(Object.keys(r.itemSpecifics)).toEqual(['Marke']);
  });

  it('laesst sie stehen, wenn das Entfernen abgeschaltet ist', () => {
    const r = repair({ Zustand: 'Neu', Marke: 'X' }, { dropMisplaced: false });
    expect(r.itemSpecifics.Zustand).toBe('Neu');
  });

  it('behaelt einen Namen, der in DIESER Kategorie ein gueltiger Aspekt ist', () => {
    const r = repairAspectsForCategory({
      categoryId: '1',
      itemSpecifics: { Zustand: 'Neuwertig' },
      catalogAspectNames: ['Zustand', 'Marke'],
      mode: 'on',
    });
    expect(r.itemSpecifics.Zustand).toBe('Neuwertig');
  });
});

describe('Verlustfreiheit und Betriebsarten', () => {
  it('laesst unbekannte Namen unangetastet stehen', () => {
    const r = repair({ Koffermaterial: 'Aluminium', Irgendwas: 'Wert' });
    expect(r.itemSpecifics.Irgendwas).toBe('Wert');
  });

  it('aendert im Modus off gar nichts', () => {
    const r = repair({ 'Gewicht (kg)': '16', Zustand: 'Neu' }, { mode: 'off' });
    expect(r.itemSpecifics).toEqual({ 'Gewicht (kg)': '16', Zustand: 'Neu' });
    expect(r.changed).toBe(false);
    expect(r.catalogAvailable).toBe(false);
  });

  it('meldet im Modus shadow die Aenderungen, mutiert aber nicht', () => {
    const eingabe = { 'Gewicht (kg)': '16', Zustand: 'Neu' };
    const r = repair(eingabe, { mode: 'shadow' });
    expect(r.itemSpecifics).toEqual(eingabe);
    expect(r.changed).toBe(false);
    expect(r.aenderungen.length).toBeGreaterThan(0);
  });

  it('fasst ohne Katalog nichts an (fail-closed)', () => {
    const r = repairAspectsForCategory({
      categoryId: '33089',
      itemSpecifics: { Zustand: 'Neu' },
      catalogAspectNames: [],
      mode: 'on',
    });
    expect(r.itemSpecifics).toEqual({ Zustand: 'Neu' });
    expect(r.catalogAvailable).toBe(false);
  });

  it('fasst ohne Kategorie nichts an', () => {
    const r = repairAspectsForCategory({
      itemSpecifics: { Zustand: 'Neu' },
      catalogAspectNames: KATALOG,
      mode: 'on',
    });
    expect(r.itemSpecifics).toEqual({ Zustand: 'Neu' });
  });

  it('wirft bei Muell-Eingaben nicht', () => {
    expect(() => repairAspectsForCategory(null)).not.toThrow();
    expect(() => repairAspectsForCategory({ itemSpecifics: null, mode: 'on' })).not.toThrow();
  });
});

describe('resolveRepairMode — Default ist aus', () => {
  const saved = process.env.EBAY_ASPECT_REPAIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.EBAY_ASPECT_REPAIR;
    else process.env.EBAY_ASPECT_REPAIR = saved;
  });

  it('ohne ENV aus', () => {
    delete process.env.EBAY_ASPECT_REPAIR;
    expect(resolveRepairMode()).toBe('off');
  });

  it('unbekannter Wert faellt auf aus zurueck', () => {
    process.env.EBAY_ASPECT_REPAIR = 'vielleicht';
    expect(resolveRepairMode()).toBe('off');
  });

  it('erkennt shadow und on', () => {
    process.env.EBAY_ASPECT_REPAIR = 'shadow';
    expect(resolveRepairMode()).toBe('shadow');
    process.env.EBAY_ASPECT_REPAIR = 'on';
    expect(resolveRepairMode()).toBe('on');
  });
});
